import { readdirSync } from "node:fs";
import { join } from "node:path";

export function assertSafePublicArtifacts(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.aws|credentials|settings\.credentials\.(?:json|ya?ml|toml))$/i.test(entry.name)) {
      throw new Error("Secret configuration must not be included in public artifacts");
    }
    if (entry.isDirectory()) assertSafePublicArtifacts(join(root, entry.name));
  }
}
