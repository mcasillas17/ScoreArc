package model

// MatchOfficial is an ingester-internal record of one provider officiating-crew
// member. SourceID stays in ESPN's identity space; canonical official resolution
// belongs in the ingester, where the external-reference crosswalk is available.
type MatchOfficial struct {
	SourceID string
	FullName string
	Role     string
	RoleID   string
	Order    int
}
