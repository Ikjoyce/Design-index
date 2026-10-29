import type { AnalysisResult } from '@design-index/shared';

export function analysisFixture(hex = '#7C5CFF'): AnalysisResult {
  return {
    summary: 'A spacious editorial interface with a vivid accent.',
    labels: { style: [{ value: 'minimal', confidence: 0.9 }], color: [{ value: 'vibrant', confidence: 0.9 }], layout: [{ value: 'spacious', confidence: 0.8 }], typography: [{ value: 'sans-serif', confidence: 0.8 }], motion: [{ value: 'unknown', confidence: 1 }], component: [{ value: 'card', confidence: 0.8 }] },
    palette_roles: { background: null, surface: null, text: null, 'muted-text': null, accent: hex, border: null },
    type_notes: 'A sans-serif type class; exact fonts were not measured.',
    motion_notes: 'Unknown from a still image.', free_tags: ['visual-rhythm'],
    quality: { issues: [] }, review: { needs_review: false, reasons: [] },
  };
}

export function promptFixture(hex = '#7C5CFF') {
  return { body: `## Intent\nBuild a calm coding interface with generous spacing.\n\n## Palette\nUse ${hex} as a restrained accent.\n\n## Typography\nUse a readable sans-serif system.\n\n## Avoid\nAvoid unnecessary motion and brand assets.`, assumptions: ['Spacing is inferred, not measured.'] };
}
