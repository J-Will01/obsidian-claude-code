const SERVICE_NAME = "obsidian-claude-code";
const API_KEY_ACCOUNT = "anthropic-api-key";
const OAUTH_TOKEN_ACCOUNT = "claude-code-oauth-token";

type KeytarModule = {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
};

let keytarModule: KeytarModule | null = null;

function loadKeytar(): KeytarModule | null {
  if (keytarModule) return keytarModule;
  try {
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
  return keytar.getPassword(SERVICE_NAME, API_KEY_ACCOUNT);
}

export async function setKeychainApiKey(apiKey: string): Promise<void> {
  const keytar = loadKeytar();
  if (!keytar) return;
  await keytar.setPassword(SERVICE_NAME, API_KEY_ACCOUNT, apiKey);
}

export async function deleteKeychainApiKey(): Promise<void> {
  const keytar = loadKeytar();
  if (!keytar) return;
  await keytar.deletePassword(SERVICE_NAME, API_KEY_ACCOUNT);
}

export async function getKeychainOAuthToken(): Promise<string | null> {
  const keytar = loadKeytar();
  if (!keytar) return null;
  return keytar.getPassword(SERVICE_NAME, OAUTH_TOKEN_ACCOUNT);
}

export async function setKeychainOAuthToken(oauthToken: string): Promise<void> {
  const keytar = loadKeytar();
  if (!keytar) return;
  await keytar.setPassword(SERVICE_NAME, OAUTH_TOKEN_ACCOUNT, oauthToken);
}

export async function deleteKeychainOAuthToken(): Promise<void> {
  const keytar = loadKeytar();
  if (!keytar) return;
  await keytar.deletePassword(SERVICE_NAME, OAUTH_TOKEN_ACCOUNT);
}
