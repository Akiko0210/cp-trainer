// Evaluate usaco.guide's content/ordering.ts and dump it as JSON.
// Run: node parse_ordering.mjs <path-to-ordering.ts>
// (Node 23 strips TS types natively, so importing the .ts file just works —
// far more robust than regex-parsing TypeScript from Python.)
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(process.argv[2]).href);
const ordering = mod.default ?? mod.MODULE_ORDERING;
if (!ordering) throw new Error("ordering.ts had no default/MODULE_ORDERING export");
console.log(JSON.stringify(ordering));
