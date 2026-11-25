package espn

import "testing"

func TestCoreSinglePageCollectionsRequireVerifiedItems(t *testing.T) {
	for name, input := range map[string]string{
		"moved items":      `{"data":{"items":[]}}`,
		"null items":       `{"items":null}`,
		"wrong items type": `{"items":{}}`,
		"short collection": `{"count":1,"items":[]}`,
		"more pages":       `{"pageCount":2,"items":[]}`,
		"declared partial": `{"truncated":true,"items":[]}`,
		"next nested page": `{"pagination":{"next":"another"},"items":[]}`,
		"null count":       `{"count":null,"items":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if crew, err := MapOfficials([]byte(input)); err == nil || len(crew) > 0 {
				t.Errorf("officials=%v err=%v, want rejected collection", crew, err)
			}
			if odds, err := MapOdds([]byte(input)); err == nil || len(odds) > 0 {
				t.Errorf("odds=%v err=%v, want rejected collection", odds, err)
			}
		})
	}
}

func TestCoreSinglePageCollectionsAcceptCompleteFullPage(t *testing.T) {
	const pagination = `"count":1,"pageIndex":1,"pageSize":1,"pageCount":1,"extra":true`
	crew, err := MapOfficials([]byte(`{` + pagination + `,"items":[{"id":"1","fullName":"Referee"}]}`))
	if err != nil || len(crew) != 1 || crew[0].SourceID != "1" {
		t.Errorf("officials=%v err=%v, want the full page", crew, err)
	}
	odds, err := MapOdds([]byte(`{` + pagination + `,"items":[{"provider":{"id":"2","name":"Book"}}]}`))
	if err != nil || len(odds) != 1 || odds[0].ProviderID != "2" {
		t.Errorf("odds=%v err=%v, want the full page", odds, err)
	}
}
