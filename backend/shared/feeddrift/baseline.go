package feeddrift

import "strings"

// Reviewed against ../espn/testdata/{espn-team-roster,espn-athlete-bio}.json.
// Object members are optional unless the ingestion contract requires them.
// ESPN collection metadata and the 404 biography are alternate envelopes
// accepted by espn.validateCollectionMetadata and ValidateAthleteBioEnvelope.
type shape struct {
	types    string
	fields   map[string]*shape
	item     *shape
	required []string
}

var (
	textValue      = &shape{types: "string"}
	number         = &shape{types: "number"}
	boolean        = &shape{types: "boolean"}
	id             = &shape{types: "string|number"}
	nullableNumber = &shape{types: "number|null"}
	seasonType     = &shape{types: "number|object", fields: map[string]*shape{"name": textValue, "slug": textValue, "id": id}}
)

func object(textFields string, fields map[string]*shape, required ...string) *shape {
	if fields == nil {
		fields = make(map[string]*shape)
	}
	for _, key := range strings.Fields(textFields) {
		fields[key] = textValue
	}
	return &shape{types: "object", fields: fields, required: required}
}

func array(item *shape) *shape { return &shape{types: "array", item: item} }

var (
	metadata = object("", map[string]*shape{
		"count": number, "total": number, "totalCount": number, "pageCount": number, "pageIndex": number, "offset": number, "pageSize": number, "limit": number,
		"truncated": boolean, "hasMore": boolean, "next": {types: "string|null"}, "nextPage": {types: "string|null"},
	})
	ref   = object("$ref", nil)
	links = array(object("href language shortText text", map[string]*shape{
		"rel": array(textValue), "isExternal": boolean, "isPremium": boolean,
	}))
	measurement = object("abbreviation description displayName displayValue name shortDisplayName", map[string]*shape{"value": nullableNumber}, "name", "value")
	category    = collection(object("abbreviation displayName name shortDisplayName summary", map[string]*shape{"stats": array(measurement)}, "stats"))
	statistics  = collection(object("", map[string]*shape{
		"splits": collection(object("abbreviation name type", map[string]*shape{"id": id, "categories": array(category)}, "categories")),
	}, "splits"))
	athlete = object("citizenship dateOfBirth displayHeight displayName displayWeight firstName fullName gender guid jersey lastName middleName shortName slug uid", map[string]*shape{
		"id": id, "age": number, "height": number, "weight": number, "profiled": boolean,
		"birthPlace": object("", nil), "citizenshipCountry": object("abbreviation", map[string]*shape{"alternateId": id}),
		"defaultLeague": ref, "defaultTeam": ref, "events": ref, "leagues": ref, "seasons": ref, "transactions": ref,
		"flag":     object("alt href", map[string]*shape{"rel": array(textValue)}),
		"headshot": object("alt href", nil), "links": links, "injuries": array(nil),
		"position": object("abbreviation displayName name", map[string]*shape{"id": id, "leaf": boolean}),
		"status":   object("abbreviation name type", map[string]*shape{"id": id}), "statistics": statistics,
	}, "id")
	roster = collection(object("status timestamp", map[string]*shape{
		"season":   object("displayName name slug", map[string]*shape{"year": number, "type": seasonType}, "year"),
		"league":   object("slug", map[string]*shape{"id": id}),
		"team":     object("abbreviation clubhouse color displayName location logo name recordSummary seasonSummary standingSummary", map[string]*shape{"id": id, "isNational": boolean}, "id"),
		"athletes": array(athlete),
	}, "status", "team", "athletes", "season"))
	bio = collection(object("message", map[string]*shape{
		"code": number, "teamHistory": array(object("displayName logo seasonCount seasons slug uid", map[string]*shape{
			"id": id, "links": links, "isActive": boolean,
		}, "id", "displayName", "seasons")),
	}))
)

func collection(s *shape) *shape {
	for k, v := range metadata.fields {
		s.fields[k] = v
	}
	s.fields["pagination"] = metadata
	return s
}

// These are the measurement names present in the recorded roster. Maintain
// the baseline independently of which stats ScoreArc decides to publish.
var knownStats = map[string]bool{
	"appearances": true, "foulsCommitted": true, "foulsSuffered": true, "goalAssists": true, "goalsConceded": true,
	"offsides": true, "ownGoals": true, "redCards": true, "saves": true, "shotsFaced": true, "shotsOnTarget": true,
	"subIns": true, "totalGoals": true, "totalShots": true, "yellowCards": true,
}
