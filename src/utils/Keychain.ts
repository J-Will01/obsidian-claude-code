const SERVICE_NAME = "obsidian-claude-code";
const ACCOUNT_NAME = "anthropic-api-key";

type KeytarModule = {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
};

let keytarModule: KeytarModule | null = null;

function loadKeytar(): KeytarModule | null {
  if (keytarModule) return keytarModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require("keytar") as KeytarModule;
    keytarModule = loaded;
    return keytarModule;
  } catch {
    return null;
  }
}

export function isKeytarAvailable(): boolean {
  return !!loadKeytar();
}

export async function getKeychainApiKey(): Promise<string | null> {
  const keytar = loadKeytar();
  if (!keytar) return null;
  return keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
}

export async function setKeychainApiKey(apiKey: string): Promise<void> {
  const keytar = loadKeytar();
  if (!keytar) return;
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, apiKey);
}

export async function deleteKeychainApiKey(): Promise<void> {
  const keytar = loadKeytar();
  if (!keytar) return;
  await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
}
