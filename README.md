# Gumroad Sales Ledger

Sync your Gumroad sales into your Obsidian vault. You get a sales ledger note, running totals in a note for each product, and a small block that shows today's sales in your daily note.

## Features

- **Sales ledger.** `Gumroad/Sales ledger.md` lists every product with its sales, gross, amount after Gumroad's fee, refunds and last sale date, plus overall totals.
- **Product notes.** Each product gets a note in `Gumroad/Products/`. The plugin keeps a "Gumroad sales" section in it (a summary line and the 20 most recent sales) and a few frontmatter properties: `gumroad_sales`, `gumroad_gross_usd`, `gumroad_net_usd`, `gumroad_refunds` and `gumroad_last_sale`. Everything else in the note is yours: write your changelog, listing copy and ideas around the section and the plugin leaves it alone. You can rename or move product notes; the plugin finds them by their `gumroad_product_id` property.
- **Sales in any note.** Add a `gumroad-sales` code block to show sales for a day or a range:

  ````markdown
  ```gumroad-sales
  ```
  ````

  shows today. Options, one per line:

  ```
  date: 2026-11-13   # the last day to show (default: today)
  days: 7            # how many days ending on that date (default: 1)
  ```

  In a daily note template, use `date: {{date:YYYY-MM-DD}}` so each daily note keeps showing its own day. The block updates after every sync.
- **Refunds stay current.** Each sync re-checks the last 30 days (adjustable), so refunds and chargebacks on recent sales show up.

## Setup

1. In Gumroad, go to Settings → Advanced → Applications, create an application, and click **Generate access token**.
2. In Obsidian, open Settings → Gumroad Sales Ledger. Under **Access token**, create a secret and paste the token into it.
3. Run **Gumroad Sales Ledger: Sync sales** from the command palette, or click the dollar sign in the ribbon. The first sync fetches your whole history, which can take a while for a large store: Gumroad returns 10 sales per request.

## Commands

- **Sync sales:** fetch new sales and recheck recent ones.
- **Rebuild from full sales history:** fetch everything again. Use it if the ledger ever looks wrong.

## Notes on the numbers

- Amounts are in USD, as Gumroad reports them in its API, whatever currency the buyer paid in.
- "After Gumroad fees" subtracts Gumroad's fee only. Payment processor fees, taxes and payouts are not included.
- Fully refunded and charged-back sales are counted as refunds and left out of revenue. Partially refunded sales count at their full price and are flagged as "partially refunded".

## Privacy

- The plugin talks only to `api.gumroad.com`, and only when you sync.
- Your access token is kept in Obsidian's secret storage, not in the plugin's data file. It is sent in a request header, never in a URL.
- Buyer details (email, name, address) are never stored or written to your vault. The plugin keeps only each sale's id, date, product, price, fee, quantity and refund status.

## Installation

### Manual

Copy `main.js` and `manifest.json` into `<your vault>/.obsidian/plugins/gumroad-sales-ledger/`, then enable the plugin in Settings → Community plugins. Requires Obsidian 1.11.4 or later.

### Development

```bash
npm install
npm test        # unit tests for parsing, totals and the notes the plugin writes
npm run lint    # ESLint with eslint-plugin-obsidianmd
npm run build   # type-check and build main.js
```

## Releases

Publishing a GitHub release tagged with the version in `manifest.json` (for example `1.0.0`) runs the Release workflow. It lints, tests and builds the plugin, attests build provenance for `main.js`, and attaches `main.js` and `manifest.json` to the release.

## License

0BSD
