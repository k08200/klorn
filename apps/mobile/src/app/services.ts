/**
 * App-wide singletons: the API client (with the in-memory session token) and
 * its typed endpoints. Created once before the first render, because mock
 * mode swaps the transport through a dynamic import (kept out of the prod
 * bundle by the MOCK_API constant).
 */
import { type ApiClient, createApiClient, type Transport } from "../api/client";
import { type Endpoints, endpoints } from "../api/endpoints";
import { API_BASE, MOCK_API } from "../config";

export interface Services {
  api: ApiClient;
  ep: Endpoints;
  mock: boolean;
}

let token: string | null = null;
const unauthorizedListeners = new Set<() => void>();
let services: Services | null = null;

export function setSessionToken(next: string | null): void {
  token = next;
}

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export async function initServices(): Promise<Services> {
  if (services) return services;
  let transport: Transport | undefined;
  let baseUrl = API_BASE;
  if (MOCK_API) {
    const mock = await import("../api/mock/transport");
    transport = mock.createMockTransport({ latencyMs: 250 });
    baseUrl = "https://mock.klorn.invalid";
  }
  const api = createApiClient({
    baseUrl,
    getToken: () => token,
    onUnauthorized: () => {
      for (const listener of unauthorizedListeners) listener();
    },
    transport,
  });
  services = { api, ep: endpoints(api), mock: MOCK_API };
  return services;
}

export function getServices(): Services {
  if (!services) throw new Error("initServices() has not run");
  return services;
}
