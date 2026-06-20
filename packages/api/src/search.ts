/**
 * Web Search for Eve — uses DuckDuckGo HTML scraping (no API key needed)
 */

import { wrapUntrusted } from "./untrusted.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(
  query: string,
  maxResults = 5,
): Promise<{ results: SearchResult[] }> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Klorn-Bot/1.0)",
    },
  });

  const html = await res.text();
  const results: SearchResult[] = [];

  // Parse DuckDuckGo HTML results
  const resultRegex =
    /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.+?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null = resultRegex.exec(html);

  while (match !== null && results.length < maxResults) {
    const rawUrl = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const snippet = match[3].replace(/<[^>]+>/g, "").trim();

    // DuckDuckGo uses redirect URLs, extract actual URL
    let actualUrl = rawUrl;
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      actualUrl = decodeURIComponent(uddgMatch[1]);
    }

    if (title && actualUrl) {
      results.push({
        title: wrapUntrusted(title, "web:title"),
        url: actualUrl,
        snippet: wrapUntrusted(snippet, "web:snippet"),
      });
    }
    match = resultRegex.exec(html);
  }

  // Fallback: simpler pattern
  if (results.length === 0) {
    const simpleRegex =
      /<a[^>]*class="result__url"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    match = simpleRegex.exec(html);
    while (match !== null && results.length < maxResults) {
      const u = match[1].trim();
      const s = match[2].replace(/<[^>]+>/g, "").trim();
      if (u && s) {
        results.push({
          title: wrapUntrusted(u, "web:title"),
          url: u.startsWith("http") ? u : `https://${u}`,
          snippet: wrapUntrusted(s, "web:snippet"),
        });
      }
      match = simpleRegex.exec(html);
    }
  }

  return { results };
}

export const SEARCH_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the web for information. Use this for research, finding answers, checking facts, looking up companies, people, news, etc.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results to return (default 5)" },
        },
        required: ["query"],
      },
    },
  },
];
