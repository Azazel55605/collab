export const WIDGET_SCHEMA_VERSION = 1;

export type WidgetKind = 'agenda';
export type WidgetPrivacy = 'full' | 'titleOnly' | 'private';

export interface WidgetDisplayOptions {
  horizonDays: number;
  maxItems: number;
  showCompleted: boolean;
}

export interface WidgetActionOptions {
  openItem: boolean;
  toggleTask: boolean;
}

export interface WidgetConfiguration {
  schemaVersion: number;
  configurationId: string;
  kind: WidgetKind;
  selectedSourceIds: string[];
  privacy: WidgetPrivacy;
  display: WidgetDisplayOptions;
  actions: WidgetActionOptions;
  updatedAt: string;
}

export interface WidgetAppearanceSnapshot {
  schemaVersion: number;
  theme: 'dark' | 'midnight' | 'warm' | 'light';
  accent: 'violet' | 'blue' | 'emerald' | 'rose' | 'orange' | 'cyan';
  fontScale: number;
  timeZone: string;
  timeFormat: 'system' | '12-hour' | '24-hour';
  showDeclined: boolean;
}
