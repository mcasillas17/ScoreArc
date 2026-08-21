export const en = {
  'common.close': 'Close',
  'common.unavailable': 'Unavailable',
  'common.scoreArcHome': 'ScoreArc home',
  'matches.count': (count: number) => `${count} ${count === 1 ? 'match' : 'matches'}`,
  'meta.root.title': 'ScoreArc · Live Football',
  'meta.root.description': 'Live football brackets, scores, and standings — every arc.',
  'meta.root.imageAlt': 'ScoreArc — Live Football',
} as const;

type WidenMessage<T> = T extends (...args: infer Args) => string
  ? (...args: Args) => string
  : string;

export type Messages = { [Key in keyof typeof en]: WidenMessage<(typeof en)[Key]> };
export type MessageKey = keyof Messages;
