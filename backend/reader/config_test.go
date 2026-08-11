package main

import "testing"

func TestLoadConfigFrom(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		env     map[string]string
		want    Config
		wantErr bool
	}{
		{name: "requires database URL", wantErr: true},
		{
			name: "defaults port",
			env:  map[string]string{"DATABASE_URL": "postgres://reader@example/db"},
			want: Config{DatabaseURL: "postgres://reader@example/db", Port: "8080"},
		},
		{
			name: "accepts valid port",
			env: map[string]string{
				"DATABASE_URL": "postgres://reader@example/db",
				"PORT":         "9090",
			},
			want: Config{DatabaseURL: "postgres://reader@example/db", Port: "9090"},
		},
		{
			name: "rejects non-numeric port",
			env: map[string]string{
				"DATABASE_URL": "postgres://reader@example/db",
				"PORT":         "http",
			},
			wantErr: true,
		},
		{
			name: "rejects out-of-range port",
			env: map[string]string{
				"DATABASE_URL": "postgres://reader@example/db",
				"PORT":         "65536",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			getenv := func(key string) string { return tt.env[key] }
			got, err := loadConfigFrom(getenv)
			if (err != nil) != tt.wantErr {
				t.Fatalf("loadConfigFrom() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("loadConfigFrom() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
