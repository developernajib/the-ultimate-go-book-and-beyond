package shortener_test

import (
	"testing"

	"github.com/example/url-shortener/pkg/shortener"
)

func TestEncode(t *testing.T) {
	cases := []struct {
		input uint64
		want  string
	}{
		{0, "0"},
		{1, "1"},
		{35, "z"},
		{62, "10"},
		{3844, "100"},
	}

	for _, tc := range cases {
		got := shortener.Encode(tc.input)
		if got != tc.want {
			t.Errorf("Encode(%d) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestDecode(t *testing.T) {
	cases := []struct {
		input string
		want  uint64
	}{
		{"0", 0},
		{"1", 1},
		{"z", 35},
		{"10", 62},
		{"100", 3844},
	}

	for _, tc := range cases {
		got, err := shortener.Decode(tc.input)
		if err != nil {
			t.Errorf("Decode(%q) unexpected error: %v", tc.input, err)
		}
		if got != tc.want {
			t.Errorf("Decode(%q) = %d, want %d", tc.input, got, tc.want)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	values := []uint64{0, 1, 100, 1000, 999999, 1<<32 - 1}
	for _, v := range values {
		encoded := shortener.Encode(v)
		decoded, err := shortener.Decode(encoded)
		if err != nil {
			t.Errorf("round-trip error for %d: %v", v, err)
		}
		if decoded != v {
			t.Errorf("round-trip failed for %d: got %d via %q", v, decoded, encoded)
		}
	}
}

func TestDecodeInvalidChar(t *testing.T) {
	_, err := shortener.Decode("abc!xyz")
	if err == nil {
		t.Error("expected error for invalid base62 character, got nil")
	}
}
