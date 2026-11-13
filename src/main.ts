import {
	App,
	MarkdownRenderChild,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	TFile,
	TFolder,
	normalizePath,
} from 'obsidian';
import { fetchSales } from './gumroad';
import {
	LedgerSale,
	cell,
	formatUsd,
	groupByProduct,
	localDay,
	mergeSales,
	parseBlockOptions,
	parseSale,
	productTotals,
	renderProductBlock,
	renderSummary,
	safeFileName,
	salesInRange,
	summaryLine,
	syncAfterDate,
	totalsFor,
	upsertBlock,
} from './ledger';

interface Settings {
	/** Name of the secret in Obsidian's secret storage that holds the Gumroad access token. */
	tokenSecretId: string;
	folder: string;
	syncOnStartup: boolean;
	/** How far before the last sync an incremental sync re-fetches, to catch refunds. */
	lookbackDays: number;
}

interface PluginData {
	settings: Settings;
	sales: Record<string, LedgerSale>;
	lastSyncedAt: string | null;
}

const DEFAULT_LOOKBACK_DAYS = 30;

const DEFAULT_SETTINGS: Settings = {
	tokenSecretId: '',
	folder: 'Gumroad',
	syncOnStartup: false,
	lookbackDays: DEFAULT_LOOKBACK_DAYS,
};

const MAX_LOOKBACK_DAYS = 365;
const CENTS_PER_DOLLAR = 100;
const RESULT_NOTICE_MS = 8000;
const PRODUCT_ID_KEY = 'gumroad_product_id';
const SYNCED_EVENT = 'gumroad-sales-ledger:synced';

export default class GumroadSalesLedgerPlugin extends Plugin {
	data: PluginData = { settings: { ...DEFAULT_SETTINGS }, sales: {}, lastSyncedAt: null };
	private syncing = false;

	async onload(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<PluginData> | null;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...(loaded?.settings ?? {}) },
			sales: loaded?.sales ?? {},
			lastSyncedAt: loaded?.lastSyncedAt ?? null,
		};

		this.addSettingTab(new LedgerSettingTab(this.app, this));

		this.addCommand({ id: 'sync', name: 'Sync sales', callback: () => void this.sync(false) });
		this.addCommand({
			id: 'rebuild',
			name: 'Rebuild from full sales history',
			callback: () => void this.sync(true),
		});
		this.addRibbonIcon('dollar-sign', 'Sync Gumroad sales', () => void this.sync(false));

		this.registerMarkdownCodeBlockProcessor('gumroad-sales', (source, el, ctx) => {
			ctx.addChild(new SalesBlock(el, source, this));
		});

		this.app.workspace.onLayoutReady(() => {
			if (this.data.settings.syncOnStartup && this.token()) void this.sync(false);
		});
	}

	async save(): Promise<void> {
		await this.saveData(this.data);
	}

	token(): string | null {
		const id = this.data.settings.tokenSecretId;
		return id ? this.app.secretStorage.getSecret(id) : null;
	}

	allSales(): LedgerSale[] {
		return Object.values(this.data.sales);
	}

	onSynced(callback: () => void, component: MarkdownRenderChild): void {
		component.registerEvent(this.app.workspace.on(SYNCED_EVENT as 'quit', callback));
	}

	async sync(full: boolean): Promise<void> {
		if (this.syncing) {
			new Notice('A Gumroad sync is already running.');
			return;
		}
		const token = this.token();
		if (!token) {
			new Notice('Add your Gumroad access token in the Gumroad Sales Ledger settings first.');
			return;
		}
		this.syncing = true;
		const progress = new Notice('Syncing Gumroad sales…', 0);
		try {
			const after = full ? null : syncAfterDate(this.data.lastSyncedAt, this.data.settings.lookbackDays);
			const raw = await fetchSales(token, after, (n) => progress.setMessage(`Fetched ${n} Gumroad sales…`));
			const parsed = raw.map(parseSale);
			const fetched = parsed.filter((s): s is LedgerSale => s !== null);
			const merged = mergeSales(full ? {} : this.data.sales, fetched);
			const syncedAt = new Date().toISOString();
			this.data = { ...this.data, sales: merged.sales, lastSyncedAt: syncedAt };
			await this.save();

			const firstSync = full || after === null;
			const touched = new Set(fetched.map((s) => s.productId));
			const skippedNotes = await this.writeNotes(firstSync ? null : touched, syncedAt);
			this.app.workspace.trigger(SYNCED_EVENT);

			progress.hide();
			const parts = [`Gumroad sync done: ${merged.added} new, ${merged.updated} updated.`];
			const unreadable = parsed.length - fetched.length;
			if (unreadable > 0) parts.push(`${unreadable} sales were missing fields and were skipped.`);
			if (skippedNotes.length > 0) {
				parts.push(`Skipped ${skippedNotes.join(', ')}: its sales section markers are damaged.`);
			}
			new Notice(parts.join(' '), RESULT_NOTICE_MS);
		} catch (error) {
			progress.hide();
			new Notice(`Gumroad sync failed. ${error instanceof Error ? error.message : String(error)}`, RESULT_NOTICE_MS);
		} finally {
			this.syncing = false;
		}
	}

	/** Write the summary note and product notes. `onlyProducts` null means every product. Returns notes it had to skip. */
	private async writeNotes(onlyProducts: Set<string> | null, syncedAt: string): Promise<string[]> {
		const folder = normalizePath(this.data.settings.folder.trim() || DEFAULT_SETTINGS.folder);
		const productsFolder = normalizePath(`${folder}/Products`);
		await this.ensureFolder(folder);
		await this.ensureFolder(productsFolder);

		const existing = this.productNotesById();
		const groups = groupByProduct(this.allSales());
		const notes = new Map<string, TFile>();
		const skipped: string[] = [];

		// One note at a time: two products whose names clean up to the same file name must not race to create it.
		await [...groups.entries()].reduce(async (previous, [productId, sales]) => {
			await previous;
			const known = existing.get(productId);
			if (onlyProducts && !onlyProducts.has(productId) && known) {
				notes.set(productId, known);
				return;
			}
			const file = known ?? (await this.createProductNote(productsFolder, productId, sales));
			notes.set(productId, file);
			const ok = await this.updateProductNote(file, productId, sales, syncedAt);
			if (!ok) skipped.push(file.basename);
		}, Promise.resolve());

		const summaryPath = normalizePath(`${folder}/Sales ledger.md`);
		const content = renderSummary(productTotals(this.allSales()), syncedAt, (t) => {
			const file = notes.get(t.productId);
			const name = cell(t.productName);
			return file ? cell(this.app.fileManager.generateMarkdownLink(file, summaryPath, '', t.productName)) : name;
		});
		const summary = this.app.vault.getAbstractFileByPath(summaryPath);
		if (summary instanceof TFile) await this.app.vault.modify(summary, content);
		else if (!summary) await this.app.vault.create(summaryPath, content);
		else throw new Error(`"${summaryPath}" is a folder, so the summary note can't be written there.`);
		return skipped;
	}

	private productNotesById(): Map<string, TFile> {
		return this.app.vault.getMarkdownFiles().reduce((map, file) => {
			const id: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[PRODUCT_ID_KEY];
			if (typeof id === 'string' && !map.has(id)) map.set(id, file);
			return map;
		}, new Map<string, TFile>());
	}

	private async ensureFolder(path: string): Promise<void> {
		const found = this.app.vault.getAbstractFileByPath(path);
		if (found instanceof TFolder) return;
		if (found) throw new Error(`"${path}" is a file, so the ledger folder can't be created there.`);
		await this.app.vault.createFolder(path);
	}

	private async createProductNote(productsFolder: string, productId: string, sales: LedgerSale[]): Promise<TFile> {
		const name = safeFileName([...sales].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0].productName);
		const plain = normalizePath(`${productsFolder}/${name}.md`);
		const path = this.app.vault.getAbstractFileByPath(plain)
			? normalizePath(`${productsFolder}/${name} (${safeFileName(productId)}).md`)
			: plain;
		return this.app.vault.create(path, '');
	}

	/** Returns false when the note's managed section is damaged and was left alone. */
	private async updateProductNote(file: TFile, productId: string, sales: LedgerSale[], syncedAt: string): Promise<boolean> {
		const block = renderProductBlock(sales, syncedAt);
		let ok = true;
		await this.app.vault.process(file, (content) => {
			const next = upsertBlock(content, block);
			if (next === null) ok = false;
			return next ?? content;
		});
		if (!ok) return false;
		const t = totalsFor(sales);
		const values: Record<string, unknown> = {
			[PRODUCT_ID_KEY]: productId,
			gumroad_sales: t.sales,
			gumroad_gross_usd: t.grossCents / CENTS_PER_DOLLAR,
			gumroad_net_usd: t.netCents / CENTS_PER_DOLLAR,
			gumroad_refunds: t.refunds,
			gumroad_last_sale: t.lastSaleAt ? localDay(t.lastSaleAt) : null,
		};
		// processFrontMatter hands us the parsed frontmatter to change in place; that is its API.
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			Object.assign(fm, values);
		});
		return true;
	}
}

/** Renders a `gumroad-sales` code block and re-renders after each sync. */
class SalesBlock extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly plugin: GumroadSalesLedgerPlugin,
	) {
		super(containerEl);
	}

	onload(): void {
		this.render();
		this.plugin.onSynced(() => this.render(), this);
	}

	private render(): void {
		const el = this.containerEl;
		el.empty();
		if (!this.plugin.data.lastSyncedAt) {
			el.createEl('p', { text: 'No Gumroad sales synced yet. Run "Gumroad Sales Ledger: Sync sales".' });
			return;
		}
		let range;
		try {
			range = parseBlockOptions(this.source, localDay(new Date().toISOString()));
		} catch (error) {
			el.createEl('p', { text: `gumroad-sales: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		const sales = salesInRange(this.plugin.allSales(), range);
		const label = range.from === range.to ? range.to : `${range.from} to ${range.to}`;
		el.createEl('p', { text: `Gumroad, ${label}: ${summaryLine(totalsFor(sales), false)}` });
		const products = productTotals(sales).filter((t) => t.sales > 0 || t.refunds > 0);
		if (products.length === 0) return;
		const list = el.createEl('ul');
		products.forEach((t) => {
			const refunds = t.refunds > 0 ? `, ${t.refunds} refunded` : '';
			list.createEl('li', { text: `${t.productName}: ${t.sales} sold, ${formatUsd(t.grossCents)}${refunds}` });
		});
	}
}

class LedgerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: GumroadSalesLedgerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.data.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Access token')
			.setDesc(
				'Pick or create a secret holding your Gumroad access token. Generate one in Gumroad on the advanced settings page, in the applications section. It is kept in Obsidian\'s secret storage, not in the plugin\'s data file.',
			)
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(settings.tokenSecretId).onChange(async (value) => {
					settings.tokenSecretId = value ?? '';
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName('Folder')
			.setDesc('Where the summary note and product notes go.')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.folder)
					.setValue(settings.folder)
					.onChange(async (value) => {
						settings.folder = value;
						await this.plugin.save();
					}),
			);

		new Setting(containerEl)
			.setName('Sync when Obsidian starts')
			.addToggle((toggle) =>
				toggle.setValue(settings.syncOnStartup).onChange(async (value) => {
					settings.syncOnStartup = value;
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName('Recheck window (days)')
			.setDesc('Each sync re-fetches this many days before the last sync, so recent refunds and chargebacks show up.')
			.addText((text) =>
				text.setValue(String(settings.lookbackDays)).onChange(async (value) => {
					const days = Number(value);
					if (!Number.isInteger(days) || days < 0 || days > MAX_LOOKBACK_DAYS) return;
					settings.lookbackDays = days;
					await this.plugin.save();
				}),
			);
	}
}
