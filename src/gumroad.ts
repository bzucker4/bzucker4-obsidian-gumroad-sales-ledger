import { requestUrl } from 'obsidian';
import { parseSalesPage } from './ledger';

const SALES_URL = 'https://api.gumroad.com/v2/sales';

/** Gumroad returns 10 sales per page, so this caps a single sync at 100,000 sales. */
const MAX_PAGES = 10_000;

/**
 * Fetch every sale since `after` (YYYY-MM-DD), or the whole history when `after` is null.
 * The token goes in the Authorization header, never in the URL.
 */
export async function fetchSales(
	token: string,
	after: string | null,
	onProgress: (fetched: number) => void,
): Promise<unknown[]> {
	const fetchPage = async (pageKey: string | null, collected: unknown[], pagesLeft: number): Promise<unknown[]> => {
		if (pagesLeft === 0) {
			throw new Error(`Stopped after ${MAX_PAGES} pages. Narrow the sync window and try again.`);
		}
		const params = new URLSearchParams();
		if (after) params.set('after', after);
		if (pageKey) params.set('page_key', pageKey);
		const query = params.toString();
		const response = await requestUrl({
			url: query ? `${SALES_URL}?${query}` : SALES_URL,
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		const page = parseSalesPage(response.status, readJson(response.text));
		collected.push(...page.sales);
		onProgress(collected.length);
		return page.nextPageKey ? fetchPage(page.nextPageKey, collected, pagesLeft - 1) : collected;
	};
	return fetchPage(null, [], MAX_PAGES);
}

function readJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}
