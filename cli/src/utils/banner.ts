import pc from "picocolors";

const COMBYNE_ART = [
  " ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗   ██╗███╗   ██╗███████╗",
  "██╔════╝██╔═══██╗████╗ ████║██╔══██╗╚██╗ ██╔╝████╗  ██║██╔════╝",
  "██║     ██║   ██║██╔████╔██║██████╔╝ ╚████╔╝ ██╔██╗ ██║█████╗  ",
  "██║     ██║   ██║██║╚██╔╝██║██╔══██╗  ╚██╔╝  ██║╚██╗██║██╔══╝  ",
  "╚██████╗╚██████╔╝██║ ╚═╝ ██║██████╔╝   ██║   ██║ ╚████║███████╗",
  " ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═════╝    ╚═╝   ╚═╝  ╚═══╝╚══════╝",
] as const;

const TAGLINE = "Open-source orchestration for zero-human companies";

export function printCombyneCliBanner(): void {
  const lines = [
    "",
    ...COMBYNE_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
