/** Metadata-only discovery result. Full instructions are deliberately absent. */
export interface SkillMetadata {
  name: string;
  description: string;
  revision?: string;
}

export interface SkillOptions {
  origin?: string;
  resourceBase?: string;
  allowedTools?: readonly string[];
  paths?: readonly string[];
}

/** Full instructions loaded on demand from an arbitrary source. */
export class Skill {
  readonly origin?: string;
  readonly resourceBase?: string;
  readonly allowedTools: readonly string[];
  readonly paths: readonly string[];

  constructor(
    readonly name: string,
    readonly description: string,
    readonly body: string,
    options: SkillOptions = {},
  ) {
    this.origin = options.origin;
    this.resourceBase = options.resourceBase;
    this.allowedTools = [...(options.allowedTools ?? [])];
    this.paths = [...(options.paths ?? [])];
  }

  /** Render the context disclosed after the skill tool is invoked. */
  context(argumentsText = ''): string {
    let body = this.body;
    let prefix = '';
    if (this.resourceBase) {
      body = body
        .replaceAll('${NEXORA_SKILL_ROOT}', this.resourceBase)
        .replaceAll('${NEXORA_SKILL_DIR}', this.resourceBase);
      prefix = `Resource base for this skill: ${this.resourceBase}\n\n`;
    }
    body = body
      .replaceAll('${ARGUMENTS}', argumentsText)
      .replaceAll('$ARGUMENTS', argumentsText);
    const argumentBlock = argumentsText ? `\n\nArguments: ${argumentsText}` : '';
    return `${prefix}${body}${argumentBlock}`;
  }
}

/** Metadata-first store for directory, database, API, or package-backed skills. */
export interface SkillSource {
  list(): Promise<readonly SkillMetadata[]>;
  load(name: string): Promise<Skill | null>;
}
