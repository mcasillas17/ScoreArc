package espn

import "github.com/mcasillas17/scorearc-backend/shared/model"

type MatchState = model.MatchState

const (
	MatchStateScheduled = model.MatchStateScheduled
	MatchStateLive      = model.MatchStateLive
	MatchStateFinished  = model.MatchStateFinished
)

type Team = model.Team
type Match = model.Match
type BracketTeam = model.BracketTeam
type BracketMatch = model.BracketMatch
type Standing = model.Standing
type TopScorer = model.TopScorer
type StatLeader = model.StatLeader
type Scorer = model.Scorer
type Card = model.Card
type TeamStats = model.TeamStats
type MatchStats = model.MatchStats
type WinProbability = model.WinProbability
type Shootout = model.Shootout
type PenaltyKick = model.PenaltyKick
type ShootoutDetail = model.ShootoutDetail
type LineupPlayer = model.LineupPlayer
type TeamLineup = model.TeamLineup
type MatchLineups = model.MatchLineups
type MatchVideo = model.MatchVideo
type MatchInfo = model.MatchInfo
type FormResult = model.FormResult
type MatchForm = model.MatchForm
type CommentaryItem = model.CommentaryItem
type CommentaryLine = model.CommentaryLine
type H2HMeeting = model.H2HMeeting
type MatchDetail = model.MatchDetail

// Ingester-internal participation shapes (never serialized to the reader).
type SquadPlayer = model.SquadPlayer
type PlayerMatchStats = model.PlayerMatchStats
type PlayerEvent = model.PlayerEvent
type MatchParticipation = model.MatchParticipation

const (
	PlayerEventGoal    = model.PlayerEventGoal
	PlayerEventOwnGoal = model.PlayerEventOwnGoal
	PlayerEventYellow  = model.PlayerEventYellow
	PlayerEventRed     = model.PlayerEventRed
	PlayerEventSubOn   = model.PlayerEventSubOn
	PlayerEventSubOff  = model.PlayerEventSubOff
)
