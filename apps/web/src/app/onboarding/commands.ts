/**
 * The setup command the wizard shows for each CLI.
 *
 * Whatever we print here gets copied into a terminal we cannot see: it may be
 * bash, zsh, cmd or PowerShell, and the wizard has no way to know which. So
 * every command below is written to run, unchanged, in all of them. In
 * practice that means three rules:
 *
 *   1. ONE line. A trailing `\` continues a line in bash and means nothing in
 *      PowerShell, so a pasted multi-line block errors out there.
 *   2. No heredoc, no `~`, no `cat >>`. PowerShell has none of them.
 *   3. Inside the double quotes, no `$` and no backtick — PowerShell expands
 *      both, bash expands `$`. Our own values (an https URL and an
 *      `ocb_<hex>` token) never contain them, and `assertCrossShell` below
 *      keeps it that way.
 *
 * Codex is the awkward one: `codex mcp add` has no `--header` flag (it errors
 * out on it), and a remote server carries its Authorization in
 * `~/.codex/config.toml`, which is what the CLI reads back. Where this used to
 * be a bash heredoc, it is now a single `node -e` — node is already on the
 * machine of anyone who has these CLIs, and the same line runs in bash and in
 * PowerShell. It is also idempotent: it rewrites the `# overclick:` block
 * instead of appending a second one, matching what install.sh does.
 */

/** Characters a shell would eat before the command ever reaches the CLI. */
const SHELL_HOSTILE = /[$`\\]/;

function assertCrossShell(command: string): string {
  if (SHELL_HOSTILE.test(command)) {
    throw new Error(`onboarding command is not cross-shell: ${command}`);
  }
  return command;
}

const codexScript = (baseUrl: string, secret: string) => [
  "const fs=require('fs'),os=require('os'),path=require('path');",
  "const nl=String.fromCharCode(10),q=String.fromCharCode(34);",
  "const dir=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');",
  "const file=path.join(dir,'config.toml');",
  "fs.mkdirSync(dir,{recursive:true});",
  "let kept=[],skip=false;",
  "try{kept=fs.readFileSync(file,'utf8').split(nl).filter(line=>{",
  "const t=line.trim();",
  "if(t==='# overclick:start'){skip=true;return false}",
  "if(t==='# overclick:end'){skip=false;return false}",
  "return skip===false})}catch(e){}",
  "while(kept.length>0&&kept[kept.length-1].trim()===''){kept.pop()}",
  "if(kept.length>0){kept.push('')}",
  "kept.push('# overclick:start','[mcp_servers.overclick]',",
  `'url = '+q+'${baseUrl}'+q,`,
  `'http_headers = { Authorization = '+q+'Bearer ${secret}'+q+' }',`,
  "'# overclick:end','');",
  "fs.writeFileSync(file,kept.join(nl));",
  // 384 is 0600: the file now holds a bearer token. chmod is a no-op on
  // Windows, hence the try.
  "try{fs.chmodSync(file,384)}catch(e){}",
  "console.log('overclick configured in '+file)",
].join("");

export function commandFor(cli: string, baseUrl: string, secret: string): string {
  const header = `--header "Authorization: Bearer ${secret}"`;
  switch (cli) {
    case "claude-code":
      return assertCrossShell(
        `claude mcp add --transport http overclick ${baseUrl} ${header}`,
      );
    case "codex":
      return assertCrossShell(`node -e "${codexScript(baseUrl, secret)}"`);
    case "gemini-cli":
      return assertCrossShell(
        `gemini mcp add --transport http overclick ${baseUrl} ${header}`,
      );
    default:
      // Not a command: `#` opens a comment in bash and in PowerShell alike, so
      // pasting it is harmless in either.
      return `# generic MCP over HTTP\n# url:    ${baseUrl}\n# header: Authorization: Bearer ${secret}`;
  }
}
