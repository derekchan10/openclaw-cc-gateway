export interface CliInput {
  prompt: string;
  model: string;
  sessionId?: string;
  systemPrompt?: string;
}

export interface CliContentDelta {
  type: "content_delta";
  content: string;
}

export interface CliTextBlockStart {
  type: "text_block_start";
}

export interface CliContentBlockStop {
  type: "content_block_stop";
}

export interface CliAssistantMessage {
  type: "assistant";
  message: {
    role: "assistant";
    content: string;
    model?: string;
  };
}

export interface CliResult {
  type: "result";
  result: {
    role: "assistant";
    content: string;
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

export interface CliError {
  type: "error";
  error: string;
}

export type CliEvent =
  | CliContentDelta
  | CliTextBlockStart
  | CliContentBlockStop
  | CliAssistantMessage
  | CliResult
  | CliError;
