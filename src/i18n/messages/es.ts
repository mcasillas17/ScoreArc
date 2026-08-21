import type { Messages } from './en';

export const es = {
  'common.close': 'Cerrar',
  'common.unavailable': 'No disponible',
  'common.scoreArcHome': 'Inicio de ScoreArc',
  'matches.count': (count: number) => `${count} ${count === 1 ? 'partido' : 'partidos'}`,
  'meta.root.title': 'ScoreArc · Fútbol en vivo',
  'meta.root.description': 'Cuadros, resultados y clasificaciones de fútbol en vivo — en cada arco.',
  'meta.root.imageAlt': 'ScoreArc — Fútbol en vivo',
} satisfies Messages;
