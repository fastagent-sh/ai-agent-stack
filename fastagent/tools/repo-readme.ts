import { defineTool, z } from "@fastagent-sh/fastagent";

// What a project actually is, as opposed to how it introduces itself. Every verdict needs this.
//   fastagent tool repo-readme '{"repo":"pydantic/pydantic-ai"}'
const STRIP = /!\[[^\]]*\]\([^)]*\)|<[^>]+>|\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g;

export default defineTool({
  description:
    "The README of a GitHub repository, images and badges removed, trimmed to `chars`. Returns the " +
    "description and topics too, so a verdict can weigh what the project claims against what it documents.",
  input: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
    chars: z.number().int().min(200).max(6000).default(1500),
  }),
  async execute({ repo, chars }) {
    const headers: Record<string, string> = { "user-agent": "ai-agent-stack" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const info = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!info.ok) throw new Error(`GET /repos/${repo} failed: ${info.status}`);
    const meta = (await info.json()) as { description?: string; topics?: string[]; stargazers_count: number; archived: boolean };

    const raw = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`, { signal: AbortSignal.timeout(20_000) });
    const readme = raw.ok ? (await raw.text()).replace(STRIP, " ").replace(/\s+/g, " ").trim().slice(0, chars) : "";
    return {
      repo,
      stars: meta.stargazers_count,
      archived: meta.archived,
      description: meta.description ?? "",
      topics: meta.topics ?? [],
      // An empty README is itself a finding: say so rather than judging on the description alone.
      readme: readme || "(no README could be read)",
    };
  },
});
