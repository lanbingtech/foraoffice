// Modified for ForaOffice from GenOffice v0.12.852.
import { createOfficeCliTools } from '../runtime/cli-resource-tools'
import { getNativeAgentServices } from '../host/docs-host'
import type { AgentSkill } from '@genoffice/agent-core'
import type { UserCliRun } from '../../shared/ipc'

/**
 * The command line the user's skills teach, as an AgentSkill.
 *
 * Skills themselves are not offered to the model: no listing, no lookup. The
 * only way a skill's text reaches a turn is the user attaching it from the
 * composer "+" menu, and then it rides in front of the request (see
 * withAttachedSkills). What stays here is `run_cli`, so an attached skill
 * that says "run genoffice convert …" can be followed. The main process owns
 * the boundary — it spawns the bundled genoffice CLI and nothing else
 * (user-cli.ts) — so this file is a caller, not a guard.
 */

const SKILLS_SYSTEM_PROMPT = `## Attached skills and the command line
The user may attach a skill to a message: its full text then appears at the
top of that message inside <skill> tags. Follow its steps with the document
tools you already have; quote its constraints rather than paraphrasing them,
and prefer its steps over guessing. Never assume a skill the user did not
attach.
- run_cli executes the bundled genoffice command line (the same "genoffice …
  --json" contract skills describe). Use it when an attached skill directs you
  to, or for batch work no single document call covers. It runs only this
  app's CLI — it is not a general shell — and long output is truncated.`

export function createSkillsSkill(
  runCli: (args: string[], signal?: AbortSignal) => Promise<UserCliRun> = (args) =>
    getNativeAgentServices().runCli(args),
): AgentSkill {
  return { id: 'skills', systemPrompt: SKILLS_SYSTEM_PROMPT, ...createOfficeCliTools(runCli) }
}
