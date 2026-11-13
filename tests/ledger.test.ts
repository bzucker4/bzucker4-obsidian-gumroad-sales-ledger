import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	BLOCK_END,
	BLOCK_START,
	LedgerSale,
	RECENT_SALES_LIMIT,
	cell,
	formatUsd,
	mergeSales,
	parseBlockOptions,
	parseSale,
	parseSalesPage,
	productTotals,
	renderProductBlock,
	renderSummary,
	safeFileName,
	salesInRange,
	summaryLine,
	syncAfterDate,
	totalsFor,
	upsertBlock,
} from '../src/ledger';

// Dates in these tests are local times; pin the zone so they mean the same thing everywhere.
// Date reads TZ when it is first used, so setting it here, before any test runs, is enough.
process.env.TZ = 'UTC';

const PRICE = 2900;
const FEE = 319;
const NET = PRICE - FEE;
const BIG_PRICE = 5000;
const SMALL_PRICE = 100;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

const LOOKBACK_DAYS = 30;
const WEEK = 7;
const TWO = 2;
const THREE = 3;
const MAX_NAME_LENGTH = 120;
const SALES_IN_BLOCK_TEST = 25;
const YEAR = 2026;
const NOON = 12;

/** Assert that `fn` throws an Error whose message contains `text`. */
const throwsWith = (fn: () => unknown, text: string): void => {
	assert.throws(fn, (error: unknown) => error instanceof Error && error.message.includes(text));
};

/** A sale shaped like one from GET /v2/sales (version 2), with buyer fields included. */
const apiSale = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: 'sale-1',
	email: 'buyer@example.com',
	full_name: 'Buyer Name',
	created_at: '2026-11-13T15:30:00Z',
	product_id: 'prod-a',
	product_name: 'Notion OS',
	price: PRICE,
	gumroad_fee: FEE,
	quantity: 1,
	refunded: false,
	partially_refunded: false,
	chargedback: false,
	...overrides,
});

const sale = (overrides: Partial<LedgerSale> = {}): LedgerSale => ({
	id: 's1',
	createdAt: '2026-11-13T15:30:00Z',
	productId: 'prod-a',
	productName: 'Notion OS',
	priceCents: PRICE,
	feeCents: FEE,
	quantity: 1,
	refunded: false,
	partiallyRefunded: false,
	chargedback: false,
	...overrides,
});

test('parseSale keeps sale fields and drops buyer details', () => {
	const parsed = parseSale(apiSale());
	assert.deepEqual(parsed, sale({ id: 'sale-1' }));
	assert.ok(!JSON.stringify(parsed).includes('buyer@example.com'));
	assert.ok(!JSON.stringify(parsed).includes('Buyer Name'));
});

test('parseSale rejects sales missing required fields or with a bad date', () => {
	assert.equal(parseSale(apiSale({ id: undefined })), null);
	assert.equal(parseSale(apiSale({ product_id: '' })), null);
	assert.equal(parseSale(apiSale({ created_at: 'yesterday' })), null);
	assert.equal(parseSale(null), null);
	assert.equal(parseSale([]), null);
});

test('parseSale falls back for odd numeric fields', () => {
	const parsed = parseSale(apiSale({ price: '29', gumroad_fee: null, quantity: 0, product_name: undefined }));
	assert.equal(parsed?.priceCents, 0);
	assert.equal(parsed?.feeCents, 0);
	assert.equal(parsed?.quantity, 1);
	assert.equal(parsed?.productName, 'prod-a');
});

test('parseSalesPage reads sales and the next page key', () => {
	const page = parseSalesPage(HTTP_OK, { success: true, sales: [apiSale()], next_page_key: 'abc-123' });
	assert.equal(page.sales.length, 1);
	assert.equal(page.nextPageKey, 'abc-123');
	assert.equal(parseSalesPage(HTTP_OK, { success: true, sales: [] }).nextPageKey, null);
});

test('parseSalesPage turns failures into readable errors', () => {
	throwsWith(() => parseSalesPage(HTTP_UNAUTHORIZED, { success: false }), 'access token');
	throwsWith(() => parseSalesPage(HTTP_FORBIDDEN, null), 'access token');
	throwsWith(() => parseSalesPage(HTTP_TOO_MANY, null), 'rate limiting');
	throwsWith(
		() => parseSalesPage(HTTP_BAD_REQUEST, { success: false, message: 'Invalid page_key.' }),
		'(400): Invalid page_key.',
	);
	throwsWith(() => parseSalesPage(HTTP_SERVER_ERROR, null), '(500).');
	throwsWith(() => parseSalesPage(HTTP_OK, { success: false, message: 'Nope' }), 'unexpected response: Nope');
	throwsWith(() => parseSalesPage(HTTP_OK, '<html>'), 'unexpected response');
});

test('mergeSales counts new and changed sales and replaces old copies', () => {
	const stored = { s1: sale(), s2: sale({ id: 's2' }) };
	const result = mergeSales(stored, [sale({ id: 's2', refunded: true }), sale({ id: 's3' }), sale()]);
	assert.equal(result.added, 1);
	assert.equal(result.updated, 1);
	assert.equal(result.sales.s2.refunded, true);
	assert.equal(Object.keys(result.sales).length, THREE);
	assert.equal(stored.s2.refunded, false, 'stored sales are not changed in place');
});

test('totalsFor leaves refunds and chargebacks out of revenue', () => {
	const kept = sale({ id: 'a', quantity: TWO });
	const partial = sale({ id: 'd', priceCents: SMALL_PRICE, feeCents: 0, partiallyRefunded: true });
	const t = totalsFor([
		kept,
		sale({ id: 'b', refunded: true }),
		sale({ id: 'c', chargedback: true, createdAt: '2026-11-14T00:00:00Z' }),
		partial,
	]);
	assert.deepEqual(t, {
		sales: TWO,
		units: THREE,
		grossCents: PRICE + SMALL_PRICE,
		feeCents: FEE,
		netCents: NET + SMALL_PRICE,
		refunds: TWO,
		partialRefunds: 1,
		lastSaleAt: '2026-11-14T00:00:00Z',
	});
});

test('totalsFor of nothing is zero', () => {
	assert.equal(totalsFor([]).sales, 0);
	assert.equal(totalsFor([]).lastSaleAt, null);
});

test('productTotals groups by product, names from the newest sale, sorts by gross', () => {
	const totals = productTotals([
		sale({ id: 'a', productId: 'p1', productName: 'Old name', priceCents: SMALL_PRICE, createdAt: '2026-01-01T00:00:00Z' }),
		sale({ id: 'b', productId: 'p1', productName: 'New name', priceCents: SMALL_PRICE, createdAt: '2026-02-01T00:00:00Z' }),
		sale({ id: 'c', productId: 'p2', productName: 'Big seller', priceCents: BIG_PRICE }),
	]);
	assert.deepEqual(
		totals.map((t) => [t.productId, t.productName, t.grossCents]),
		[
			['p2', 'Big seller', BIG_PRICE],
			['p1', 'New name', SMALL_PRICE + SMALL_PRICE],
		],
	);
});

test('formatUsd formats cents', () => {
	const cases: [number, string][] = [
		[0, '$0.00'],
		[Number('5'), '$0.05'],
		[PRICE, '$29.00'],
		[Number('123456789'), '$1,234,567.89'],
		[Number('-250'), '-$2.50'],
	];
	cases.forEach(([cents, text]) => assert.equal(formatUsd(cents), text));
});

test('syncAfterDate goes back the lookback window from the last sync', () => {
	assert.equal(syncAfterDate(null, LOOKBACK_DAYS), null);
	assert.equal(syncAfterDate('not a date', LOOKBACK_DAYS), null);
	assert.equal(syncAfterDate('2026-11-13T10:00:00Z', LOOKBACK_DAYS), '2026-10-14');
	assert.equal(syncAfterDate('2026-11-13T10:00:00Z', 0), '2026-11-13');
});

test('safeFileName removes characters that break file names and links', () => {
	assert.equal(safeFileName('Kit #2: A/B [beta]'), 'Kit 2 A B beta');
	assert.equal(safeFileName('..hidden'), 'hidden');
	assert.equal(safeFileName('  Notion   OS  '), 'Notion OS');
	assert.equal(safeFileName('///'), 'Untitled product');
	assert.equal(safeFileName('x'.repeat(MAX_NAME_LENGTH + MAX_NAME_LENGTH)).length, MAX_NAME_LENGTH);
});

test('cell escapes pipes and line breaks for tables', () => {
	assert.equal(cell('A|B\nC'), 'A\\|B C');
});

test('summaryLine pluralises and only mentions refunds when there are some', () => {
	assert.equal(summaryLine(totalsFor([sale()])), '**1 sale** · $29.00 gross · $25.81 after Gumroad fees');
	assert.equal(
		summaryLine(totalsFor([sale(), sale({ id: 'x', refunded: true })]), false),
		'1 sale · $29.00 gross · $25.81 after Gumroad fees · 1 refund',
	);
});

test('renderProductBlock lists newest sales first, capped, inside markers', () => {
	const sales = Array.from({ length: SALES_IN_BLOCK_TEST }, (_, i) =>
		sale({
			id: `s${i}`,
			createdAt: new Date(Date.UTC(YEAR, 0, 1 + i, NOON)).toISOString(),
			refunded: i === SALES_IN_BLOCK_TEST - 1,
		}),
	);
	const block = renderProductBlock(sales, '2026-11-13T12:00:00Z');
	const lines = block.split('\n');
	assert.equal(lines[0], BLOCK_START);
	assert.equal(lines[lines.length - 1], BLOCK_END);
	const rows = lines.filter((l) => l.startsWith('| 2026'));
	assert.equal(rows.length, RECENT_SALES_LIMIT);
	assert.equal(rows[0], '| 2026-01-25 12:00 | $29.00 | 1 | Refunded |');
	assert.equal(rows[RECENT_SALES_LIMIT - 1], '| 2026-01-06 12:00 | $29.00 | 1 |  |');
	assert.ok(block.includes('Last 20 of 25 sales. Synced 2026-11-13 12:00.'));
});

test('upsertBlock appends to a note without a block and keeps the note text', () => {
	assert.equal(upsertBlock('My notes\n\n', 'BLOCK'), 'My notes\n\nBLOCK\n');
	assert.equal(upsertBlock('', 'BLOCK'), 'BLOCK\n');
});

test('upsertBlock replaces only the managed block', () => {
	const note = `Intro\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\nOutro`;
	const next = upsertBlock(note, `${BLOCK_START}\nnew\n${BLOCK_END}`);
	assert.equal(next, `Intro\n\n${BLOCK_START}\nnew\n${BLOCK_END}\n\nOutro`);
});

test('upsertBlock refuses damaged markers', () => {
	assert.equal(upsertBlock(`${BLOCK_START}\nno end`, 'B'), null);
	assert.equal(upsertBlock(`no start\n${BLOCK_END}`, 'B'), null);
	assert.equal(upsertBlock(`${BLOCK_END}\n${BLOCK_START}`, 'B'), null);
	assert.equal(upsertBlock(`${BLOCK_START}${BLOCK_END}${BLOCK_START}${BLOCK_END}`, 'B'), null);
});

test('renderSummary has a row per product and overall totals', () => {
	const totals = productTotals([
		sale({ id: 'a', productId: 'p1', productName: 'One' }),
		sale({ id: 'b', productId: 'p2', productName: 'Two', refunded: true }),
	]);
	const text = renderSummary(totals, '2026-11-13T12:00:00Z', (t) => `[[${t.productName}]]`);
	assert.ok(text.includes('**1 sale** · $29.00 gross · $25.81 after Gumroad fees · 1 refund'));
	assert.ok(text.includes('| [[One]] | 1 | $29.00 | $25.81 | 0 | 2026-11-13 |'));
	assert.ok(text.includes('| [[Two]] | 0 | $0.00 | $0.00 | 1 | 2026-11-13 |'));
});

test('parseBlockOptions defaults to today and supports date and days', () => {
	assert.deepEqual(parseBlockOptions('', '2026-11-13'), { from: '2026-11-13', to: '2026-11-13' });
	assert.deepEqual(parseBlockOptions(`days: ${WEEK}`, '2026-11-13'), { from: '2026-11-07', to: '2026-11-13' });
	assert.deepEqual(parseBlockOptions('date: 2026-03-01\ndays: 2', '2026-11-13'), {
		from: '2026-02-28',
		to: '2026-03-01',
	});
});

test('parseBlockOptions rejects bad input with a readable message', () => {
	throwsWith(() => parseBlockOptions('date: 2026-02-30', '2026-11-13'), "isn't a date");
	throwsWith(() => parseBlockOptions('date: tomorrow', '2026-11-13'), "isn't a date");
	throwsWith(() => parseBlockOptions('days: 0', '2026-11-13'), 'whole number');
	throwsWith(() => parseBlockOptions('days: 1.5', '2026-11-13'), 'whole number');
	throwsWith(() => parseBlockOptions('period: week', '2026-11-13'), 'Unknown option "period"');
	throwsWith(() => parseBlockOptions('last week', '2026-11-13'), "Can't read");
});

test('salesInRange uses local days, inclusive at both ends', () => {
	const sales = [
		sale({ id: 'a', createdAt: '2026-11-06T23:59:00Z' }),
		sale({ id: 'b', createdAt: '2026-11-07T00:00:00Z' }),
		sale({ id: 'c', createdAt: '2026-11-13T23:59:00Z' }),
		sale({ id: 'd', createdAt: '2026-11-14T00:00:00Z' }),
	];
	assert.deepEqual(
		salesInRange(sales, { from: '2026-11-07', to: '2026-11-13' }).map((s) => s.id),
		['b', 'c'],
	);
});
