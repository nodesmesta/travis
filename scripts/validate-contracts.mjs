import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const schemaFiles = [];
for await (const file of glob("contracts/schemas/*.json")) {
  schemaFiles.push(file);
}

for (const file of schemaFiles) {
  JSON.parse(await readFile(file, "utf8"));
}

JSON.parse(await readFile("contracts/fixtures/core-demo.json", "utf8"));
const openapi = await readFile("contracts/openapi.yaml", "utf8");
if (!openapi.includes("openapi: 3.1.0")) {
  throw new Error("contracts/openapi.yaml must declare OpenAPI 3.1.0");
}
if (!openapi.includes("/trips/{tripId}/bookings/{bookingId}/payments:")) {
  throw new Error("OpenAPI contract is missing the payment route");
}

console.log(
  `Validated ${schemaFiles.length} JSON schemas, fixture JSON, and OpenAPI markers.`,
);
