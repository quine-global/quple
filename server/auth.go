package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Verifier checks Quine access tokens (JWTs from login.quineglobal.com, the
// Keycloak realm `public`) locally with go-oidc. The issuer's discovery
// document and keys are fetched on first use rather than at startup, so this
// server can come up even while the identity server is down; go-oidc
// re-fetches keys when they rotate.
type Verifier struct {
	issuer   string
	clientID string

	mu       sync.Mutex
	verifier *oidc.IDTokenVerifier
	lastTry  time.Time
}

// discoveryRetryInterval bounds how often a failed discovery is retried, so
// a down identity server isn't hammered by every poll.
const discoveryRetryInterval = 10 * time.Second

var errIdentityUnavailable = errors.New("identity server unavailable")

func NewVerifier(issuer, clientID string) *Verifier {
	return &Verifier{issuer: strings.TrimRight(issuer, "/"), clientID: clientID}
}

func (v *Verifier) get(ctx context.Context) (*oidc.IDTokenVerifier, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.verifier != nil {
		return v.verifier, nil
	}
	if time.Since(v.lastTry) < discoveryRetryInterval {
		return nil, errIdentityUnavailable
	}
	v.lastTry = time.Now()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, http.DefaultClient), v.issuer)
	if err != nil {
		return nil, errIdentityUnavailable
	}
	// Keycloak's access tokens name the app that asked for them in `azp`;
	// their `aud` is whatever else they're good for (often "account"), so
	// the app check is ours, in Verify.
	v.verifier = provider.Verifier(&oidc.Config{SkipClientIDCheck: true})
	return v.verifier, nil
}

// Verify checks an access token and returns the username it was issued to:
// the account's email address, which is its username in the realm.
func (v *Verifier) Verify(ctx context.Context, token string) (string, error) {
	verifier, err := v.get(ctx)
	if err != nil {
		return "", err
	}
	parsed, err := verifier.Verify(ctx, token)
	if err != nil {
		return "", err
	}
	var claims struct {
		Type              string `json:"typ"`
		AuthorizedParty   string `json:"azp"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := parsed.Claims(&claims); err != nil {
		return "", err
	}
	// Keycloak signs ID, access and refresh tokens alike and tells them
	// apart by `typ`: only an access token ("Bearer") will do, and only one
	// issued to this app, not to another app of the realm.
	if claims.Type != "Bearer" || claims.AuthorizedParty != v.clientID {
		return "", errors.New("not an access token for this app")
	}
	username, err := normalizeUsername(claims.PreferredUsername)
	if err != nil {
		return "", errors.New("token has no usable username")
	}
	return username, nil
}
