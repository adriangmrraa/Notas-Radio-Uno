// Re-export shared types used by the client
export type {
  PipelineConfig,
  PipelineStatus,
  PublishedNote,
  TranscriptionChunk,
  TopicSegment,
  TopicAnalysisResult,
  Insights,
  SearchResult,
  Publication,
  Transcription,
  MetaAsset,
  MetaPublishResults,
  WebhookSettings,
} from '../../shared/types.js';

// ─── UI-specific types ───────────────────────────────────────

export type PipelineStep =
  | 'capturing'
  | 'analyzing'
  | 'searching'
  | 'generating'
  | 'creating_flyer'
  | 'publishing';

export interface StepMeta {
  icon: string;
  label: string;
}

export const STEP_META: Record<PipelineStep, StepMeta> = {
  capturing:      { icon: '\uD83C\uDFA4', label: 'Captura y Transcripci\u00f3n' },
  analyzing:      { icon: '\uD83D\uDD0D', label: 'An\u00e1lisis con IA' },
  searching:      { icon: '\uD83C\uDF10', label: 'Investigaci\u00f3n Web' },
  generating:     { icon: '\u270D\uFE0F',  label: 'Redacci\u00f3n de Nota' },
  creating_flyer: { icon: '\uD83D\uDDBC\uFE0F', label: 'Creaci\u00f3n de Placa' },
  publishing:     { icon: '\uD83D\uDCE4', label: 'Publicaci\u00f3n en Redes' },
};

export const PIPELINE_STEPS: PipelineStep[] = [
  'capturing',
  'analyzing',
  'searching',
  'generating',
  'creating_flyer',
  'publishing',
];

export const DETAIL_ICONS: Record<string, string> = {
  satellite: '\uD83D\uDCE1', check: '\u2705', mic: '\uD83C\uDFA4',
  brain: '\uD83E\uDDE0', document: '\uD83D\uDCC4', tag: '\uD83C\uDFF7\uFE0F',
  people: '\uD83D\uDC65', lightbulb: '\uD83D\uDCA1', search: '\uD83D\uDD0D',
  link: '\uD83D\uDD17', download: '\u2B07\uFE0F', info: '\u2139\uFE0F',
  edit: '\u270F\uFE0F', merge: '\uD83D\uDD00', image: '\uD83D\uDDBC\uFE0F',
  layers: '\uD83C\uDF9E\uFE0F', upload: '\u2B06\uFE0F', send: '\uD83D\uDCE8',
  rocket: '\uD83D\uDE80', clock: '\u23F3', warning: '\u26A0\uFE0F',
};

export interface ActivityCardData {
  id: string;
  icon: string;
  title: string;
  status: 'active' | 'done' | 'error';
  subSteps: SubStep[];
  previewUrl?: string;
}

export interface SubStep {
  icon: string;
  text: string;
  className?: 'sub-done' | 'sub-error' | '';
}

export type HistoryTab = 'publications' | 'transcriptions';

export interface MetaStatus {
  connected: boolean;
  pages?: Array<{ id: string; name: string }>;
  instagramAccounts?: Array<{ id: string; name?: string; username?: string }>;
  expiresAt?: string;
}

export interface PipelineUpdateEvent {
  event: string;
  step?: string;
  message?: string;
  icon?: string;
  text?: string;
  timestamp?: string;
  totalMinutes?: number;
  bufferSize?: number;
  insights?: { topics: string[]; people: string[]; keyFacts: string[] };
  resultsCount?: number;
  title?: string;
  content?: string;
  topic?: string;
  totalPublished?: number;
  previewUrl?: string;
  source?: string;
  model?: string;
  warnings?: string[];
}
