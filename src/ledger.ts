/**
 * Pure ledger logic: parsing Gumroad sales, totals, and the Markdown the plugin writes.
 * Nothing here touches Obsidian or the network, so it runs under node:test.
 */

/** A sale as the plugin stores it. Buyer details (email, name, address) are never kept. */
export interface LedgerSale {
	id: string;
	/** ISO timestamp from Gumroad. */
	createdAt: string;
	productId: string;
	productName: string;
	/** What the buyer paid, in USD cents, including Gumroad's fee. */
	priceCents: number;
	/** Gumroad's fee in USD cents. */
	feeCents: number;
	quantity: number;
	refunded: boolean;
	partiallyRefunded: boolean;
	chargedback: boolean;
}

export interface Totals {
	/** Sales that were not fully refunded or charged back. */
	sales: number;
	units: number;
	grossCents: number;
	feeCents: number;
	netCents: number;
	/** Fully refunded or charged back. */
	refunds: number;
	partialRefunds: number;
	lastSaleAt: string | null;
}

export interface ProductTotals extends Totals {
	productId: string;
	productName: string;
}

export const BLOCK_START = '<!-- gumroad-sales-ledger:start -->';
export const BLOCK_END = '<!-- gumroad-sales-ledger:end -->';

/** How many sales the per-product table lists. */
export const RECENT_SALES_LIMIT = 20;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_ERROR_MIN = 400;

const CENTS_PER_DOLLAR = 100;
const TWO_DIGITS = 2;
const MS_PER_DAY = 86_400_000;
const ISO_DATE_LENGTH = 10;
const MAX_FILE_NAME_LENGTH = 120;
const MAX_BLOCK_DAYS = 3660;

const EMPTY_TOTALS: Totals = {
	sales: 0,
	units: 0,
	grossCents: 0,
	feeCents: 0,
	netCents: 0,
	refunds: 0,
	partialRefunds: 0,
	lastSaleAt: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
	typeof value === 'string' && value.length > 0 ? value : null;

const int = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;

/** Turn one sale from the Gumroad API into a LedgerSale, or null if required fields are missing. */
export function parseSale(raw: unknown): LedgerSale | null {
	if (!isRecord(raw)) return null;
	const id = str(raw.id);
	const createdAt = str(raw.created_at);
	const productId = str(raw.product_id);
	if (!id || !createdAt || !productId || Number.isNaN(Date.parse(createdAt))) return null;
	return {
		id,
		createdAt,
		productId,
		productName: str(raw.product_name) ?? productId,
		priceCents: int(raw.price, 0),
		feeCents: int(raw.gumroad_fee, 0),
		quantity: Math.max(1, int(raw.quantity, 1)),
		refunded: raw.refunded === true,
		partiallyRefunded: raw.partially_refunded === true,
		chargedback: raw.chargedback === true,
	};
}

export interface SalesPage {
	sales: unknown[];
	nextPageKey: string | null;
}

/** Interpret one HTTP response from GET /v2/sales. Throws an Error with a readable message on failure. */
export function parseSalesPage(status: number, body: unknown): SalesPage {
	const message = isRecord(body) ? str(body.message) : null;
	const detail = message ? `: ${message}` : '.';
	if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
		throw new Error('Gumroad rejected the access token. Check it in the plugin settings.');
	}
	if (status === HTTP_TOO_MANY_REQUESTS) {
		throw new Error('Gumroad is rate limiting requests. Try again in a few minutes.');
	}
	if (status >= HTTP_ERROR_MIN) throw new Error(`Gumroad returned an error (${status})${detail}`);
	if (!isRecord(body) || body.success !== true || !Array.isArray(body.sales)) {
		throw new Error(`Gumroad sent an unexpected response${detail}`);
	}
	return { sales: body.sales, nextPageKey: str(body.next_page_key) };
}

/** Merge newly fetched sales into the stored ones. A newer copy of a sale replaces the old one (refunds change it). */
export function mergeSales(
	stored: Record<string, LedgerSale>,
	fetched: LedgerSale[],
): { sales: Record<string, LedgerSale>; added: number; updated: number } {
	return fetched.reduce(
		(acc, sale) => {
			const old = acc.sales[sale.id];
			const changed = old !== undefined && JSON.stringify(old) !== JSON.stringify(sale);
			return {
				sales: { ...acc.sales, [sale.id]: sale },
				added: acc.added + (old === undefined ? 1 : 0),
				updated: acc.updated + (changed ? 1 : 0),
			};
		},
		{ sales: { ...stored }, added: 0, updated: 0 },
	);
}

/** Whether a sale was lost to a full refund or a chargeback. */
export const isLost = (sale: LedgerSale): boolean => sale.refunded || sale.chargedback;

/** Newest first, ties broken by id so the order is stable. */
export const byNewest = (a: LedgerSale, b: LedgerSale): number =>
	Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);

const later = (a: string | null, b: string): string =>
	a !== null && Date.parse(a) >= Date.parse(b) ? a : b;

export function totalsFor(sales: LedgerSale[]): Totals {
	return sales.reduce<Totals>((t, sale) => {
		const lastSaleAt = later(t.lastSaleAt, sale.createdAt);
		if (isLost(sale)) return { ...t, refunds: t.refunds + 1, lastSaleAt };
		const grossCents = t.grossCents + sale.priceCents;
		const feeCents = t.feeCents + sale.feeCents;
		return {
			sales: t.sales + 1,
			units: t.units + sale.quantity,
			grossCents,
			feeCents,
			netCents: grossCents - feeCents,
			refunds: t.refunds,
			partialRefunds: t.partialRefunds + (sale.partiallyRefunded ? 1 : 0),
			lastSaleAt,
		};
	}, EMPTY_TOTALS);
}

/** Add up several sets of totals. */
export const sumTotals = (list: Totals[]): Totals =>
	list.reduce<Totals>(
		(acc, t) => ({
			sales: acc.sales + t.sales,
			units: acc.units + t.units,
			grossCents: acc.grossCents + t.grossCents,
			feeCents: acc.feeCents + t.feeCents,
			netCents: acc.netCents + t.netCents,
			refunds: acc.refunds + t.refunds,
			partialRefunds: acc.partialRefunds + t.partialRefunds,
			lastSaleAt: t.lastSaleAt === null ? acc.lastSaleAt : later(acc.lastSaleAt, t.lastSaleAt),
		}),
		EMPTY_TOTALS,
	);

/** Group sales by product id. */
export const groupByProduct = (sales: LedgerSale[]): Map<string, LedgerSale[]> =>
	sales.reduce((groups, sale) => {
		groups.set(sale.productId, [...(groups.get(sale.productId) ?? []), sale]);
		return groups;
	}, new Map<string, LedgerSale[]>());

/** Totals per product, highest gross first. The product name comes from the newest sale. */
export function productTotals(sales: LedgerSale[]): ProductTotals[] {
	return [...groupByProduct(sales).entries()]
		.map(([productId, list]) => ({
			productId,
			productName: [...list].sort(byNewest)[0].productName,
			...totalsFor(list),
		}))
		.sort((a, b) => b.grossCents - a.grossCents || a.productName.localeCompare(b.productName));
}

const pad = (n: number): string => String(n).padStart(TWO_DIGITS, '0');

export function formatUsd(cents: number): string {
	const sign = cents < 0 ? '-' : '';
	const abs = Math.abs(cents);
	const dollars = Math.floor(abs / CENTS_PER_DOLLAR).toLocaleString('en-US');
	return `${sign}$${dollars}.${pad(abs % CENTS_PER_DOLLAR)}`;
}

const dayOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local date of an ISO timestamp, as YYYY-MM-DD. */
export const localDay = (iso: string): string => dayOf(new Date(iso));

/** Local date and time of an ISO timestamp, as YYYY-MM-DD HH:mm. */
export function localDateTime(iso: string): string {
	const d = new Date(iso);
	return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The `after` date for an incremental sync: the last sync minus a lookback window, so refunds
 * and chargebacks on recent sales get picked up. Null means fetch the whole history.
 */
export function syncAfterDate(lastSyncedAt: string | null, lookbackDays: number): string | null {
	if (!lastSyncedAt || Number.isNaN(Date.parse(lastSyncedAt))) return null;
	return new Date(Date.parse(lastSyncedAt) - lookbackDays * MS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);
}

/**
 * Characters Obsidian or the OS won't accept in a note name, plus the ones that break links.
 * Matches "/" in "A/B" and "#" in "Kit #2"; does not match anything in "Notion OS".
 * https://regex101.com/?regex=%5B%5C%5C%2F%3A*%3F%22%3C%3E%7C%23%5E%5B%5C%5D%5D&testString=A%2FB%20Kit%20%232
 */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|#^[\]]/g;
/**
 * Runs of whitespace. Matches the "  " in "A  B"; does not match "AB".
 * https://regex101.com/?regex=%5Cs%2B&testString=A%20%20B
 */
const WHITESPACE_RUN = /\s+/g;
/**
 * Leading dots, which would hide the file. Matches ".." in "..hidden"; does not match "a.b".
 * https://regex101.com/?regex=%5E%5C.%2B&testString=..hidden
 */
const LEADING_DOTS = /^\.+/;

/** Make a product name safe to use as a note file name. */
export function safeFileName(name: string): string {
	const cleaned = name
		.replace(UNSAFE_FILE_CHARS, ' ')
		.replace(WHITESPACE_RUN, ' ')
		.trim()
		.replace(LEADING_DOTS, '')
		.slice(0, MAX_FILE_NAME_LENGTH)
		.trim();
	return cleaned || 'Untitled product';
}

/**
 * A pipe, which would split a table cell. Matches "|" in "A|B"; does not match "A/B".
 * https://regex101.com/?regex=%5C%7C&testString=A%7CB
 */
const PIPE = /\|/g;
/**
 * A line break, which would end a table row. Matches the break in "A\nB"; does not match "A B".
 * https://regex101.com/?regex=%5Cr%3F%5Cn&testString=A%0AB
 */
const LINE_BREAK = /\r?\n/g;

/** Escape text for a Markdown table cell. */
export const cell = (text: string): string => text.replace(PIPE, '\\|').replace(LINE_BREAK, ' ');

export function saleStatus(sale: LedgerSale): string {
	if (sale.chargedback) return 'Chargeback';
	if (sale.refunded) return 'Refunded';
	if (sale.partiallyRefunded) return 'Partially refunded';
	return '';
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line summarising a set of totals. `bold` wraps the sale count in Markdown emphasis. */
export function summaryLine(t: Totals, bold = true): string {
	const count = plural(t.sales, 'sale');
	return [
		bold ? `**${count}**` : count,
		`${formatUsd(t.grossCents)} gross`,
		`${formatUsd(t.netCents)} after Gumroad fees`,
		...(t.refunds > 0 ? [plural(t.refunds, 'refund')] : []),
		...(t.partialRefunds > 0 ? [`${t.partialRefunds} partially refunded`] : []),
	].join(' · ');
}

/** The managed block written into each product note. */
export function renderProductBlock(sales: LedgerSale[], syncedAt: string): string {
	const sorted = [...sales].sort(byNewest);
	const shown = sorted.slice(0, RECENT_SALES_LIMIT);
	return [
		BLOCK_START,
		'## Gumroad sales',
		'',
		summaryLine(totalsFor(sorted)),
		'',
		'| Date | Price | Quantity | Status |',
		'| --- | ---: | ---: | --- |',
		...shown.map(
			(s) => `| ${localDateTime(s.createdAt)} | ${formatUsd(s.priceCents)} | ${s.quantity} | ${saleStatus(s)} |`,
		),
		'',
		`*Last ${shown.length} of ${plural(sorted.length, 'sale')}. Synced ${localDateTime(syncedAt)}. This section is rewritten on every sync; write your own notes outside it.*`,
		BLOCK_END,
	].join('\n');
}

/**
 * Trailing whitespace at the end of a note. Matches "\n\n" at the end of "Notes\n\n"; does not match in "Notes".
 * https://regex101.com/?regex=%5Cs%2B%24&testString=Notes%0A%0A
 */
const TRAILING_WHITESPACE = /\s+$/;

const countOf = (content: string, marker: string): number => content.split(marker).length - 1;

/**
 * Put `block` into `content`, replacing an existing managed block or appending one.
 * Returns null when the markers are damaged (missing one, out of order, or repeated),
 * so the caller can skip the note instead of guessing which text to replace.
 */
export function upsertBlock(content: string, block: string): string | null {
	const starts = countOf(content, BLOCK_START);
	const ends = countOf(content, BLOCK_END);
	if (starts === 0 && ends === 0) {
		const body = content.replace(TRAILING_WHITESPACE, '');
		return `${body}${body ? '\n\n' : ''}${block}\n`;
	}
	const start = content.indexOf(BLOCK_START);
	const end = content.indexOf(BLOCK_END);
	if (starts !== 1 || ends !== 1 || end < start) return null;
	return content.slice(0, start) + block + content.slice(end + BLOCK_END.length);
}

/** The summary note, rewritten in full on every sync. `linkFor` returns the link text for a product. */
export function renderSummary(
	totals: ProductTotals[],
	syncedAt: string,
	linkFor: (t: ProductTotals) => string,
): string {
	return [
		'# Gumroad sales ledger',
		'',
		`*Synced ${localDateTime(syncedAt)}. This note is rewritten on every sync. Amounts are in USD. "After Gumroad fees" does not subtract payment processor fees.*`,
		'',
		summaryLine(sumTotals(totals)),
		'',
		'| Product | Sales | Gross | After Gumroad fees | Refunds | Last sale |',
		'| --- | ---: | ---: | ---: | ---: | --- |',
		...totals.map(
			(t) =>
				`| ${linkFor(t)} | ${t.sales} | ${formatUsd(t.grossCents)} | ${formatUsd(t.netCents)} | ${t.refunds} | ${t.lastSaleAt ? localDay(t.lastSaleAt) : ''} |`,
		),
		'',
	].join('\n');
}

export interface DayRange {
	/** First local day to include, YYYY-MM-DD. */
	from: string;
	/** Last local day to include, YYYY-MM-DD. */
	to: string;
}

/**
 * A calendar date. Matches "2026-11-13"; does not match "2026-11-1" or "Nov 13".
 * https://regex101.com/?regex=%5E%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7D%24&testString=2026-11-13
 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * An option line in a code block. Matches "days: 7" (key "days", value "7"); does not match "7 days".
 * https://regex101.com/?regex=%5E(%5Cw%2B)%5Cs*%3A%5Cs*(.*)%24&testString=days%3A%207
 */
const OPTION_LINE = /^(\w+)\s*:\s*(.*)$/;
/**
 * A positive whole number. Matches "7"; does not match "7.5" or "-1".
 * https://regex101.com/?regex=%5E%5Cd%2B%24&testString=7
 */
const WHOLE_NUMBER = /^\d+$/;

function addDays(day: string, days: number): string {
	const [y, m, d] = day.split('-').map(Number);
	return dayOf(new Date(y, m - 1, d + days));
}

const isRealDay = (value: string): boolean => DAY_PATTERN.test(value) && addDays(value, 0) === value;

interface ParsedOptions {
	date: string;
	days: number;
}

function applyOption(opts: ParsedOptions, line: string): ParsedOptions {
	const match = OPTION_LINE.exec(line);
	if (!match) throw new Error(`Can't read "${line}". Use "date: YYYY-MM-DD" or "days: N".`);
	const [, key, value] = match;
	if (key === 'date') {
		if (!isRealDay(value)) throw new Error(`"${value}" isn't a date. Use YYYY-MM-DD.`);
		return { ...opts, date: value };
	}
	if (key === 'days') {
		const days = Number(value);
		if (!WHOLE_NUMBER.test(value) || days < 1 || days > MAX_BLOCK_DAYS) {
			throw new Error(`"days" must be a whole number from 1 to ${MAX_BLOCK_DAYS}.`);
		}
		return { ...opts, days };
	}
	throw new Error(`Unknown option "${key}". Use "date" or "days".`);
}

/**
 * Parse a `gumroad-sales` code block. Supported lines:
 *   date: 2026-11-13   (the last day to show; defaults to today)
 *   days: 7            (how many days ending on `date`; defaults to 1)
 * Throws an Error with a readable message for anything else.
 */
export function parseBlockOptions(source: string, today: string): DayRange {
	const { date, days } = source
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.reduce(applyOption, { date: today, days: 1 });
	return { from: addDays(date, 1 - days), to: date };
}

/** Sales whose local day falls within the range, inclusive. */
export const salesInRange = (sales: LedgerSale[], range: DayRange): LedgerSale[] =>
	sales.filter((s) => {
		const day = localDay(s.createdAt);
		return day >= range.from && day <= range.to;
	});
