export type ModelType = 'image' | 'video' | 'text';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'canceled';

export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  protocol: 'openai-compatible' | 'custom';
  supportedTypes: ModelType[];
  enabled: boolean;
  keyCount: number;
}

export interface ModelSummary {
  id: string;
  modelId: string;
  displayName: string;
  mappingName?: string;
  type: ModelType;
  enabled: boolean;
  providerIds: string[];
  capabilities: Record<string, boolean>;
  paramTemplate: Record<string, unknown>;
  sortOrder: number;
}

export interface GenerateRequest {
  modelId: string;
  model?: string;
  prompt: string;
  ratio?: string;
  resolution?: string;
  quality?: 'low' | 'standard' | 'high';
  count?: number;
  contentType: ModelType;
  referenceImages?: string[];
  negative?: string;
  duration?: number;
  videoMode?: string;
  idempotencyKey: string;
}

export interface GenerateAccepted {
  status: 'pending';
  taskId: string;
  modelId: string;
}

export interface TaskSnapshot {
  taskId: string;
  state: TaskStatus;
  result?: { images?: string[]; videoUrl?: string; text?: string };
  error?: string;
}

export function normalizeModelId(input: Pick<GenerateRequest, 'modelId' | 'model'>): string {
  return input.modelId.trim() || (input.model || '').trim();
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'canceled';
}
