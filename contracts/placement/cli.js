#!/usr/bin/env node
// npm run conformance -- --base-url https://app.example.com --brand urbanmop --quote quote.json [--holds] [--book book.json]
// The service token comes from PLACEMENT_TOKEN, never from the command line.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { runConformance, report } from './conformance.js';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    brand: { type: 'string' },
    quote: { type: 'string' },
    days: { type: 'string', default: '14' },
    holds: { type: 'boolean', default: false },
    book: { type: 'string' },
  },
});

const token = process.env.PLACEMENT_TOKEN;
const missing = ['base-url', 'brand', 'quote'].filter((k) => !values[k]);
if (missing.length || !token) {
  console.error(`Missing: ${[...missing.map((k) => `--${k}`), ...(token ? [] : ['PLACEMENT_TOKEN'])].join(', ')}`);
  console.error('--quote is a JSON file with a QuoteRequest the app should find serviceable.');
  console.error('--book is a JSON file with { "customer": {...}, "answers": [...] }. It WRITES a real booking: sandbox only.');
  process.exit(2);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const results = await runConformance({
  baseUrl: values['base-url'],
  token,
  brand: values.brand,
  quoteRequest: readJson(values.quote),
  days: Number(values.days),
  holds: values.holds,
  book: values.book ? readJson(values.book) : null,
});
process.exit(report(results) ? 0 : 1);
