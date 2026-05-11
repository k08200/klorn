import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const nextDir = path.join(root, ".next");
const serverDir = path.join(nextDir, "server");

async function writeJsonIfMissing(filePath, data) {
  if (existsSync(filePath)) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data)}\n`);
}

await mkdir(serverDir, { recursive: true });

await writeJsonIfMissing(path.join(nextDir, "routes-manifest.json"), {
  version: 3,
  caseSensitive: false,
  basePath: "",
  rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
  redirects: [
    {
      source: "/:path+/",
      destination: "/:path+",
      permanent: true,
      internal: true,
      regex: "^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))\\/$",
    },
  ],
  headers: [],
});

await writeJsonIfMissing(path.join(serverDir, "middleware-manifest.json"), {
  version: 3,
  middleware: {},
  functions: {},
  sortedMiddleware: [],
});

await writeJsonIfMissing(path.join(serverDir, "pages-manifest.json"), {});
await writeJsonIfMissing(path.join(serverDir, "app-paths-manifest.json"), {});
