package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// Invite is a pending call: someone tried to reach a user who hasn't
// picked up (polled it) yet.
type Invite struct {
	From      string `json:"from"`
	MeetingID string `json:"meetingId"`
	// JitsiURL is the Jitsi Meet server the caller picked for this call.
	JitsiURL  string    `json:"jitsiUrl"`
	CreatedAt time.Time `json:"createdAt"`
}

// presenceWindow is how long a user is considered "online" after their last
// /register or /poll call. Clients are expected to hit one of those every
// few seconds, so this just needs to comfortably outlast that interval.
const presenceWindow = 90 * time.Second

// inviteTTL bounds how long an undelivered invite is kept around. If the
// callee's app isn't polling (closed, offline, etc.) the invite is dropped
// rather than kept forever.
const inviteTTL = 2 * time.Minute

// callIdleTTL is how long a call's state is kept after anyone last touched
// it (placed it, sent a heartbeat, hung up).
const callIdleTTL = 10 * time.Minute

var (
	errNoCall   = errors.New("no such call")
	errNotParty = errors.New("not your call")
)

// call is what the server knows about a call while it lasts: who's in it,
// when each side last sent a heartbeat from its call screen, and who hung
// up. The apps poll it to end calls whose other side is gone, whatever
// Jitsi server carries the call.
type call struct {
	parties [2]string // caller, callee
	seen    map[string]time.Time
	endedBy string
	touched time.Time
}

// CallStatus is a call as one of its parties sees it.
type CallStatus struct {
	Peer string `json:"peer"`
	// PeerSeenMsAgo is how long ago the other side last sent a heartbeat;
	// null when it never has (a callee who hasn't answered).
	PeerSeenMsAgo *int64 `json:"peerSeenMsAgo"`
	// EndedBy is who hung up (or declined), "" while the call is on.
	EndedBy string `json:"endedBy"`
}

// Store is a deliberately minimal, in-memory, process-lifetime store with no
// persistence. Accounts live in the Quine identity server; usernames here are
// whatever verified access tokens said (see auth.go).
type Store struct {
	mu       sync.Mutex
	lastSeen map[string]time.Time
	invites  map[string][]Invite
	calls    map[string]*call
}

func NewStore() *Store {
	return &Store{
		lastSeen: make(map[string]time.Time),
		invites:  make(map[string][]Invite),
		calls:    make(map[string]*call),
	}
}

func (s *Store) Touch(username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeen[username] = time.Now()
}

// IsOnline reports whether username was seen within presenceWindow.
func (s *Store) IsOnline(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.lastSeen[username]
	return ok && time.Since(t) < presenceWindow
}

// PlaceCall queues inv for to, stamping its creation time, and starts the
// call's state with the caller already in it.
func (s *Store) PlaceCall(to string, inv Invite) Invite {
	now := time.Now()
	inv.CreatedAt = now
	s.mu.Lock()
	defer s.mu.Unlock()
	s.invites[to] = append(s.invites[to], inv)
	s.sweepCalls(now)
	s.calls[inv.MeetingID] = &call{
		parties: [2]string{inv.From, to},
		seen:    map[string]time.Time{inv.From: now},
		touched: now,
	}
	return inv
}

// sweepCalls forgets calls nobody has touched in callIdleTTL. Callers hold mu.
func (s *Store) sweepCalls(now time.Time) {
	for id, c := range s.calls {
		if now.Sub(c.touched) > callIdleTTL {
			delete(s.calls, id)
		}
	}
}

// party returns meetingID's call and the other side, if me is in it.
// Callers hold mu.
func (s *Store) party(meetingID, me string, now time.Time) (*call, string, error) {
	s.sweepCalls(now)
	c, ok := s.calls[meetingID]
	if !ok {
		return nil, "", errNoCall
	}
	switch me {
	case c.parties[0]:
		return c, c.parties[1], nil
	case c.parties[1]:
		return c, c.parties[0], nil
	}
	return nil, "", errNotParty
}

// CallHeartbeat records that me's call screen is up for meetingID (which
// also counts as presence) and returns the call as me sees it.
func (s *Store) CallHeartbeat(meetingID, me string) (CallStatus, error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, peer, err := s.party(meetingID, me, now)
	if err != nil {
		return CallStatus{}, err
	}
	c.seen[me] = now
	c.touched = now
	s.lastSeen[me] = now
	st := CallStatus{Peer: peer, EndedBy: c.endedBy}
	if t, ok := c.seen[peer]; ok {
		ms := now.Sub(t).Milliseconds()
		st.PeerSeenMsAgo = &ms
	}
	return st, nil
}

// HangUp ends meetingID for both sides; the first to hang up is recorded.
func (s *Store) HangUp(meetingID, me string) error {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, _, err := s.party(meetingID, me, now)
	if err != nil {
		return err
	}
	if c.endedBy == "" {
		c.endedBy = me
	}
	c.touched = now
	return nil
}

// DrainInvites returns and clears every pending invite for username,
// filtering out anything older than inviteTTL. Polling also counts as
// presence, so it touches lastSeen too.
func (s *Store) DrainInvites(username string) []Invite {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeen[username] = time.Now()

	pending := s.invites[username]
	delete(s.invites, username)

	cutoff := time.Now().Add(-inviteTTL)
	fresh := make([]Invite, 0, len(pending))
	for _, inv := range pending {
		if inv.CreatedAt.After(cutoff) {
			fresh = append(fresh, inv)
		}
	}
	return fresh
}

func newMeetingID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return "quple-" + hex.EncodeToString(buf)
}
