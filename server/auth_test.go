package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// fakeKeycloak is an OIDC issuer shaped like Keycloak's realm: discovery,
// a JWKS, and RS256-signed tokens with Keycloak's claims.
type fakeKeycloak struct {
	srv    *httptest.Server
	signer jose.Signer
}

func newFakeKeycloak(t *testing.T) *fakeKeycloak {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	kc := &fakeKeycloak{signer: signer}
	mux := http.NewServeMux()
	kc.srv = httptest.NewServer(mux)
	t.Cleanup(kc.srv.Close)
	issuer := kc.srv.URL + "/realms/public"
	mux.HandleFunc("/realms/public/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                issuer,
			"authorization_endpoint":                issuer + "/protocol/openid-connect/auth",
			"token_endpoint":                        issuer + "/protocol/openid-connect/token",
			"jwks_uri":                              issuer + "/protocol/openid-connect/certs",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/realms/public/protocol/openid-connect/certs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"},
		}})
	})
	return kc
}

func (kc *fakeKeycloak) issuer() string { return kc.srv.URL + "/realms/public" }

// token signs Keycloak-style claims, with overrides.
func (kc *fakeKeycloak) token(t *testing.T, overrides map[string]any) string {
	t.Helper()
	now := time.Now()
	claims := map[string]any{
		"iss":                kc.issuer(),
		"sub":                "8f1c2b9e-0000-4000-8000-000000000001",
		"aud":                "account",
		"azp":                "quple",
		"typ":                "Bearer",
		"exp":                now.Add(5 * time.Minute).Unix(),
		"iat":                now.Unix(),
		"jti":                "abc",
		"preferred_username": "Alice",
	}
	for k, v := range overrides {
		if v == nil {
			delete(claims, k)
		} else {
			claims[k] = v
		}
	}
	raw, err := jwt.Signed(kc.signer).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestVerifierKeycloakTokens(t *testing.T) {
	kc := newFakeKeycloak(t)
	v := NewVerifier(kc.issuer(), "quple")
	ctx := context.Background()

	name, err := v.Verify(ctx, kc.token(t, nil))
	if err != nil || name != "alice" {
		t.Fatalf("access token: %q, %v", name, err)
	}

	for _, tc := range []struct {
		why       string
		overrides map[string]any
	}{
		{"ID token", map[string]any{"typ": "ID", "aud": "quple"}},
		{"refresh token", map[string]any{"typ": "Refresh"}},
		{"another app's token", map[string]any{"azp": "someone-else"}},
		{"no azp", map[string]any{"azp": nil}},
		{"another issuer", map[string]any{"iss": "https://evil.example/realms/public"}},
		{"expired", map[string]any{"exp": time.Now().Add(-time.Minute).Unix()}},
		{"no username", map[string]any{"preferred_username": nil}},
		{"malformed username", map[string]any{"preferred_username": "alice@example.com"}},
	} {
		if name, err := v.Verify(ctx, kc.token(t, tc.overrides)); err == nil {
			t.Errorf("%s: accepted as %q", tc.why, name)
		}
	}

	// A token signed by some other key.
	other := newFakeKeycloak(t)
	forged := other.token(t, map[string]any{"iss": kc.issuer()})
	if _, err := v.Verify(ctx, forged); err == nil {
		t.Error("token signed by another key accepted")
	}
}
