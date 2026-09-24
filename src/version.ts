import { isString } from "./core/internal/value-schema.js";
import { readFileSync } from "node:fs";

export const viteDoctorVersion = readPackageVersion();

function readPackageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return isString(manifest.version) ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
