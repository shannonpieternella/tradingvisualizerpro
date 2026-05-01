// Quick smoke test: verify token works and list current resources.
// Run: node scripts/metaapi-smoketest.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dir, "../../.env"), "utf8")
    .split("\n").filter(l => l && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })
);

const token  = env.METAAPI_TOKEN;
const region = env.METAAPI_REGION || "new-york";
if (!token) { console.error("METAAPI_TOKEN missing in .env"); process.exit(1); }

const MetaApiMod = await import("metaapi.cloud-sdk/esm-node");
const MetaApi = MetaApiMod.default?.default ?? MetaApiMod.default;
const CopyFactory = MetaApiMod.default?.CopyFactory ?? MetaApiMod.CopyFactory;

const api = new MetaApi(token, { region });
console.log(`✓ MetaApi client created (region=${region})`);

const accounts = await api.metatraderAccountApi.getAccountsWithInfiniteScrollPagination({ limit: 100 });
console.log(`✓ Trading accounts: ${accounts.length}`);
for (const a of accounts) console.log(`   - ${a.id}  ${a.name}  ${a.type}  ${a.state}`);

const profiles = await api.provisioningProfileApi.getProvisioningProfilesWithInfiniteScrollPagination({ limit: 100 });
console.log(`✓ Provisioning profiles: ${profiles.length}`);
for (const p of profiles) console.log(`   - ${p.id}  ${p.name}  v${p.version}  ${p.status}`);

if (CopyFactory) {
  const cf = new CopyFactory(token, { domain: "agiliumtrade.agiliumtrade.ai" });
  const cfg = cf.configurationApi;
  const strategies = await cfg.getStrategiesWithInfiniteScrollPagination({ limit: 100 });
  console.log(`✓ CopyFactory strategies: ${strategies.length}`);
  for (const s of strategies) console.log(`   - ${s._id}  ${s.name}`);
} else {
  console.log("(CopyFactory class not exported under expected path — will check SDK shape)");
  console.log("SDK exports:", Object.keys(MetaApiMod));
}
