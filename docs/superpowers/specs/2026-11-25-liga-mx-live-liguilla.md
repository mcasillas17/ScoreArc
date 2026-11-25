# Live Liga MX Liguilla

The men's 2026 Apertura arc shows one tie for each pair of clubs. Its scorecard shows the ida, vuelta and aggregate with each club on a consistent row. The desktop card appears beside the arc and the phone card below it. Either crest opens its tie.

Live results use the published matches from the existing DataStore. Before a draw is available, the standings seed a clearly labeled projection. Match rows already store the two legs individually in Postgres. Aggregate goals are derived by club identity. Scheduled zeroes carry no score. While a leg is in play the arc may highlight the club going through as things stand. Only two completed, valid legs can decide a tie. A level quarterfinal or semifinal favors the better regular-season seed. A level final requires extra time and, if necessary, a shootout. Four quarterfinal winners are reseeded highest vs lowest and the middle two together. Published pairings take precedence.

Build your bracket keeps an edition-scoped fan prediction separate from official scores and retains it for comparison as real results arrive. Each prediction is keyed by round and club pair so reseeding cannot attach a score to a different tie. Support sharing through the existing bracket link. Poll the visible tab through the existing bracket API. This feature needs no new database table or public data-source cutover.

The regular-season ranking tiebreak, semifinal pairings and championship tiebreak follow the [FMF Liga MX competition regulations for 2026–27](https://fmf.mx/docs/reglamentos/507.pdf). The scorecard includes any extra-time goals in the vuelta and displays shootout totals separately.
