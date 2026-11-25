import { describe, expect, it } from 'vitest';
import type { BracketMatch, BracketRound, BracketTeam } from '@/server/data/types';
import {
  analyzeLiguillaTie, buildLiguillaModel, liguillaTieKey, parseLiguillaPredictions, setLiguillaScore,
  type LiguillaPredictions,
} from './liguilla';

function team(seed: number): BracketTeam {
  return { id: String(seed), name: 'Club ' + seed, abbr: String(seed), overallSeed: seed, crestUrl: null, placeholder: false };
}
function game(home = 1, away = 8, round: BracketMatch['round'] = 'quarterfinals'): BracketMatch {
  return { id: [round,home,away].join('-'), round, home: team(home), away: team(away), homeScore: null,
    awayScore: null, kickoff: '', state: 'scheduled', statusName: 'STATUS_SCHEDULED', statusDetail: '',
    note: null, minute: null, winnerId: null };
}
function leg(number: 1|2, homeScore: number, awayScore: number, round: BracketMatch['round'] = 'quarterfinals'): BracketMatch {
  return { ...game(number === 1 ? 8 : 1, number === 1 ? 1 : 8, round), homeScore, awayScore,
    kickoff: number === 1 ? '2026-11-25T02:00Z' : '2026-11-28T02:00Z', legNumber: number,
    state: 'finished', statusName: 'STATUS_FULL_TIME' };
}
function tie(...legs: BracketMatch[]): BracketMatch {
  return { ...game(1, 8, legs[0]?.round), legs };
}
function predict(picks: LiguillaPredictions, match: BracketMatch, winner: string) {
  for (const number of [1, 2] as const) {
    for (const side of [match.home, match.away]) {
      picks = setLiguillaScore(picks, match, number, side.id, side.id === winner ? 2 : 0);
    }
  }
  return picks;
}
const analyze = (m: BracketMatch) => analyzeLiguillaTie(m).official;

describe('men’s two-leg results', () => {
  it('suppresses pre-match zeroes and a result flag on the aggregate wrapper', () => {
    const m = tie({ ...leg(1,0,0), state: 'scheduled', statusName: 'STATUS_SCHEDULED' });
    expect(analyze({ ...m, winnerId: '8' })).toMatchObject({ aggregate: [null,null], winnerId: null, leaderId: null });
  });
  it('keeps a live series lead distinct from a decided result, following the club across venues', () => {
    const ida = leg(1,2,0);
    expect(analyze(tie(ida))).toMatchObject({ aggregate: [0,2], winnerId: null, leaderId: '8' });
    const vuelta = { ...leg(2,2,0), state: 'live' as const, statusName: 'STATUS_SECOND_HALF' };
    expect(analyze(tie(vuelta,ida))).toMatchObject({ aggregate: [2,2], winnerId: null, leaderId: '1', reason: 'seed' });
    expect(analyze(tie(ida,leg(2,3,0)))).toMatchObject({ aggregate: [3,2], winnerId: '1', reason: 'aggregate' });
  });
  it.each(['quarterfinals','semifinals'] as const)('uses the higher seed only when known and distinct in %s', round => {
    const m = tie(leg(1,3,1,round),leg(2,2,0,round));
    expect(analyze(m)).toMatchObject({ winnerId: '1', reason: 'seed' });
    expect(analyze({ ...m, home: { ...m.home, overallSeed: undefined } }).winnerId).toBeNull();
    expect(analyze({ ...m, home: { ...m.home, overallSeed: 8 } }).winnerId).toBeNull();
  });
  it.each(['STATUS_ABANDONED','STATUS_CANCELED','STATUS_FORFEIT','STATUS_POSTPONED','STATUS_FINAL_AET','STATUS_FINAL_PEN'])(
    'withholds the result and a live lead on an unplayed or invalid return leg (%s)', statusName => {
      expect(analyze(tie(leg(1,4,0),{ ...leg(2,1,0), statusName }))).toMatchObject({ winnerId: null, leaderId:null });
    });
  it('requires consistent evidence of two separate completed games to advance', () => {
    const a = leg(1,2,0), b = leg(2,5,0);
    for (const m of [tie(b), tie(a, { ...b, legNumber: null }),tie(a,b,b),tie(a,{ ...b, id:a.id }),
      tie(a,{ ...b,kickoff:a.kickoff }),tie(a,{ ...b,home:a.home,away:a.away }),tie(a,{ ...b,awayScore:null })]) {
      expect(analyze(m).winnerId).toBeNull();
    }
    expect(analyze(tie(b)).aggregate).toEqual([null,null]);
  });
  it('withholds advancement and a provisional aggregate if the vuelta has started before the ida is complete', () => {
    const a = { ...leg(1,2,0), state: 'live' as const, statusName: 'STATUS_FIRST_HALF' };
    const b = leg(2,3,0);
    expect(analyze(tie(a,b))).toMatchObject({ aggregate:[null,null], leaderId:null, winnerId:null });
  });
  it('does not count shootout or extra-time scores on a scheduled game with an inconsistent provider state', () => {
    const a = leg(1,2,0,'final');
    const b = { ...leg(2,1,0,'final'), state:'scheduled' as const, statusName:'STATUS_FINAL_PEN',
      shootout: {homeScore:2,awayScore:3} };
    expect(analyzeLiguillaTie(tie(a,b)).penalties).toEqual([null,null]);
  });
  it('shows a live shootout separately without awarding the title', () => {
    const a = leg(1,1,0,'final');
    const b = { ...leg(2,1,0,'final'), state:'live' as const, statusName:'STATUS_SHOOTOUT',
      shootout:{homeScore:2,awayScore:3} };
    expect(analyzeLiguillaTie(tie(a,b))).toMatchObject({
      penalties:[2,3], official:{aggregate:[1,1],leaderId:null,winnerId:null},
    });
  });
  it('counts extra-time goals and requires a decisive shootout on a level final', () => {
    const a = leg(1,1,0,'final'), b = leg(2,1,0,'final');
    expect(analyze(tie(a,b)).winnerId).toBeNull();
    expect(analyze(tie(a,{ ...b, statusName:'STATUS_FINAL_AET', homeScore:2 }))).toMatchObject({ winnerId:'1',reason:'extra-time' });
    const pens = { ...b, statusName:'STATUS_FINAL_PEN', winnerId:'1' };
    expect(analyze(tie(a,pens)).winnerId).toBeNull();
    expect(analyze(tie(a,{ ...pens, shootout:{ homeScore:3, awayScore:4 } }))).toMatchObject({ aggregate:[1,1], winnerId:'8',reason:'penalties' });
    expect(analyze(tie(a,{ ...pens, note:'2nd Leg - Club 8 win 4-3 on penalties' })).winnerId).toBe('8');
    expect(analyze(tie(a,{ ...pens, shootout:{homeScore:3,awayScore:3} })).winnerId).toBeNull();
  });
});

describe('Liguilla forecasts', () => {
  const quarters = [[1,8],[4,5],[2,7],[3,6]].map(([a,b]) => game(a,b));
  const firstRound: BracketRound = { slug:'quarterfinals', matches:quarters };
  it('retains a forecast by club when the draw reverses orientation and locks real scores separately', () => {
    const initial = predict({},game(),'8');
    const published = { ...game(8,1), legs:[leg(1,0,1)] };
    const data: BracketRound[] = [{ slug:'quarterfinals',matches:[published] }];
    expect(liguillaTieKey(game())).toBe(liguillaTieKey(published));
    const view = buildLiguillaModel(data,initial,'predict');
    const t = view.ties[liguillaTieKey(published)];
    expect(t.legs[0]).toMatchObject({ actual:[0,1],saved:[2,0],effective:[0,1],locked:true });
    expect(t.legs[1]).toMatchObject({ actual:[null,null],saved:[2,0],effective:[2,0],locked:false });
    expect(t.forecast).toMatchObject({ aggregate:[2,1],winnerId:'8' });
    expect(t.official.winnerId).toBeNull();
    expect(data[0].matches[0].winnerId).toBeNull();
    expect(t.match).toBe(view.rounds[0].matches[0]);
    expect(buildLiguillaModel(data,initial).rounds[0].matches[0].winnerId).toBeNull();
  });
  it('does not use a live leg or an invalidated result to crown a predicted champion', () => {
    const a = leg(1,1,0,'final'), b = leg(2,2,0,'final');
    for (const vuelta of [{ ...b,state:'live' as const,statusName:'STATUS_SECOND_HALF' },{ ...b,statusName:'STATUS_ABANDONED' }]) {
      const m = tie(a,vuelta);
      const view = buildLiguillaModel([{slug:'final',matches:[m]}],predict({},m,'8'),'predict');
      expect(view.ties[liguillaTieKey(m)].forecast.winnerId).toBeNull();
    }
  });
  it('locks a withdrawn game even when the feed retains its pre-match state', () => {
    const m = tie(leg(1,0,1), { ...leg(2,0,0), state:'scheduled', statusName:'STATUS_CANCELED' });
    const view = buildLiguillaModel([{slug:'quarterfinals',matches:[m]}],predict({},m,'8'),'predict');
    expect(view.ties[liguillaTieKey(m)].legs[1].locked).toBe(true);
    expect(view.ties[liguillaTieKey(m)].forecast.winnerId).toBeNull();
  });
  it('re-seeds four survivors, ignores obsolete pair predictions and plays through the final', () => {
    let picks = quarters.reduce((p,m,i) => predict(p,m,[ '8','5','2','6' ][i]),{});
    const data = [firstRound];
    const semis = buildLiguillaModel(data,picks,'predict').rounds[1].matches;
    expect(semis.map(m => [m.home.id,m.away.id])).toEqual([['2','8'],['5','6']]);
    picks = predict(predict(picks,semis[0],'8'),semis[1],'5');
    const final = buildLiguillaModel(data,picks,'predict').rounds[2].matches[0];
    expect([final.home.id,final.away.id].sort()).toEqual(['5','8']);
    picks = predict(picks,final,'5');
    expect(buildLiguillaModel(data,picks,'predict').rounds[2].matches[0].winnerId).toBe('5');
    picks = predict(picks,quarters[0],'1');
    const newSemis = buildLiguillaModel(data,picks,'predict').rounds[1].matches;
    expect(newSemis.map(m => [m.home.id,m.away.id,m.winnerId])).toEqual([['1','6',null],['2','5',null]]);
    expect(buildLiguillaModel(data,picks).rounds[2].matches.some(m => m.winnerId)).toBe(false);
  });
  it('honors a published semifinal over an incorrect fan winner and derives the other two entrants', () => {
    const picks = quarters.reduce((p,m) => predict(p,m,m.home.id),{});
    const published = game(8,3,'semifinals');
    const view = buildLiguillaModel([firstRound,{slug:'semifinals',matches:[published]}],picks,'predict');
    expect(view.rounds[1].matches.map(m => [m.home.id,m.away.id].sort())).toEqual([['3','8'],['2','4']]);
  });
  it('waits to forecast unknown seed order, while a published pairing is still shown', () => {
    const unseeded = quarters.map(m => ({...m,home:{...m.home,overallSeed:undefined}}));
    const picks = unseeded.reduce((p,m) => predict(p,m,m.home.id),{});
    const q: BracketRound = {slug:'quarterfinals',matches:unseeded};
    expect(buildLiguillaModel([q],picks,'predict').rounds[1].matches.every(m => m.home.placeholder)).toBe(true);
    expect(buildLiguillaModel([q,{slug:'final',matches:[game(7,3,'final')]}]).rounds[2].matches[0].home.id).toBe('7');
  });
  it('settles a level final forecast by separate penalties, keeping the saved aggregate level', () => {
    const m = game(1,8,'final'), rounds = [{ slug:'final' as const,matches:[m] }];
    let picks:LiguillaPredictions = {};
    for (const n of [1,2] as const) for (const side of [m.home,m.away]) picks = setLiguillaScore(picks,m,n,side.id,0);
    expect(buildLiguillaModel(rounds,picks,'predict').ties[liguillaTieKey(m)].forecast.winnerId).toBeNull();
    picks = setLiguillaScore(setLiguillaScore(picks,m,'penalties','1',3),m,'penalties','8',4);
    const t = buildLiguillaModel(rounds,picks,'predict').ties[liguillaTieKey(m)];
    expect(t.forecast).toMatchObject({aggregate:[0,0],winnerId:'8',reason:'penalties'});
    expect(t.official.winnerId).toBeNull();
  });
  it('round-trips partial entries and rejects malformed share/local scores', () => {
    const m = game();
    const picks = setLiguillaScore({},m,2,m.away.id,0);
    expect(parseLiguillaPredictions(JSON.parse(JSON.stringify(picks)))).toEqual(picks);
    expect(setLiguillaScore(picks,m,2,m.away.id,null)).toEqual({});
    const key = liguillaTieKey(m);
    for (const invalid of [null, [], true, {junk:1},{[key]: {'1': [-5,'2']}},{[key]: {2:[100,0]}}]) {
      expect(parseLiguillaPredictions(invalid)).toEqual({});
    }
    expect(setLiguillaScore(picks,m,1,'unknown',3)).toBe(picks);
  });
});
