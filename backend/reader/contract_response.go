package main

import (
	"encoding/json"
	"net/http"
)

// Row limits do not bound historical free-text fields stored in PostgreSQL.
const maxContractResponseBytes = 1 << 20

func writeContractJSON(writer http.ResponseWriter, value any) {
	body, err := json.Marshal(value)
	if err != nil || len(body)+1 > maxContractResponseBytes {
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(append(body, '\n'))
}
