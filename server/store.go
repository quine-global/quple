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
	errNoCall    = errors.New("no such call")
	errNotParty  = errors.New("not your call")
	errCallEnded = errors.New("that call has ended")
)

// call is what the server knows about a call while it lasts: who's in it,
// when each side last sent a heartbeat from its call screen, and who hung
// up. The apps poll it to end calls whose other side is gone, whatever
// Jitsi server carries the call.
type call struct {
	parties  [2]string // caller, callee
	jitsiURL string
	seen     map[string]time.Time
	endedBy  string
	touched  time.Time
	// holders is, per party, which of their devices has the call: the first
	// one to send a heartbeat, until another moves it (MoveCall).
	holders map[string]*holder
}

// holder is the device a party's call is on.
type holder struct {
	device string
	name   string // what to call it: "iPhone", "Mac"
	joined bool   // in the Jitsi room, by its last heartbeat
	seen   time.Time
}

// movedJoinedWindow is how recent the new device's "I've joined" must be
// for the old one to leave.
const movedJoinedWindow = 10 * time.Second

// activeWindow is how recently a party must have sent a heartbeat for their
// call to be offered to their other devices (ActiveCalls).
const activeWindow = 15 * time.Second

// Heartbeat is what a call screen says about itself. Device is empty from
// apps that predate moving calls between devices.
type Heartbeat struct {
	Device string `json:"device"`
	Name   string `json:"name"`
	Joined bool   `json:"joined"`
}

// ActiveCall is a call of yours that's on another of your devices, which
// this one can take over (MoveCall).
type ActiveCall struct {
	MeetingID string `json:"meetingId"`
	Peer      string `json:"peer"`
	JitsiURL  string `json:"jitsiUrl"`
	// Device is the name of the device it's on.
	Device string `json:"device"`
}

// CallStatus is a call as one of its parties sees it.
type CallStatus struct {
	Peer string `json:"peer"`
	// PeerSeenMsAgo is how long ago the other side last sent a heartbeat;
	// null when it never has (a callee who hasn't answered).
	PeerSeenMsAgo *int64 `json:"peerSeenMsAgo"`
	// EndedBy is who hung up (or declined), "" while the call is on.
	EndedBy string `json:"endedBy"`
	// MovedTo is set when the call is now on another of your devices (its
	// name): the device sending the heartbeat should mute, and leave the
	// room once MovedJoined says the new one is in it. Leaving isn't
	// hanging up.
	MovedTo     string `json:"movedTo,omitempty"`
	MovedJoined bool   `json:"movedJoined,omitempty"`
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
		parties:  [2]string{inv.From, to},
		jitsiURL: inv.JitsiURL,
		seen:     map[string]time.Time{inv.From: now},
		touched:  now,
		holders:  map[string]*holder{},
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

// CallHeartbeat records that me's call screen is up for meetingID on
// hb.Device (which also counts as presence) and returns the call as that
// device sees it. The first device to send one holds the call.
func (s *Store) CallHeartbeat(meetingID, me string, hb Heartbeat) (CallStatus, error) {
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
	st := c.status(peer, now)
	if hb.Device == "" {
		return st, nil
	}
	h := c.holders[me]
	if h == nil {
		h = &holder{device: hb.Device, name: hb.Name}
		c.holders[me] = h
	}
	if h.device == hb.Device {
		h.joined = hb.Joined
		h.seen = now
	} else {
		st.MovedTo = h.name
		st.MovedJoined = h.joined && now.Sub(h.seen) < movedJoinedWindow
	}
	return st, nil
}

// MoveCall puts me's side of meetingID on device: its other device leaves
// once this one has joined the room (CallHeartbeat's MovedTo).
func (s *Store) MoveCall(meetingID, me, device, name string) (ActiveCall, error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, peer, err := s.party(meetingID, me, now)
	if err != nil {
		return ActiveCall{}, err
	}
	if c.endedBy != "" {
		return ActiveCall{}, errCallEnded
	}
	c.holders[me] = &holder{device: device, name: name, seen: now}
	c.touched = now
	return ActiveCall{MeetingID: meetingID, Peer: peer, JitsiURL: c.jitsiURL, Device: name}, nil
}

// ActiveCalls lists me's calls in progress on a device other than device:
// answered, not hung up, and with a heartbeat from me in activeWindow.
func (s *Store) ActiveCalls(me, device string) []ActiveCall {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepCalls(now)
	list := []ActiveCall{}
	for id, c := range s.calls {
		var peer string
		switch me {
		case c.parties[0]:
			peer = c.parties[1]
		case c.parties[1]:
			peer = c.parties[0]
		default:
			continue
		}
		if c.endedBy != "" {
			continue
		}
		if _, answered := c.seen[peer]; !answered {
			continue
		}
		if t, ok := c.seen[me]; !ok || now.Sub(t) > activeWindow {
			continue
		}
		on := ""
		if h := c.holders[me]; h != nil {
			if h.device == device {
				continue
			}
			on = h.name
		}
		list = append(list, ActiveCall{MeetingID: id, Peer: peer, JitsiURL: c.jitsiURL, Device: on})
	}
	return list
}

// CallStatus returns meetingID as me sees it, without counting as a
// heartbeat: a callee's phone checks it while ringing (has the caller
// given up?), and a heartbeat would mean "answered".
func (s *Store) CallStatus(meetingID, me string) (CallStatus, error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, peer, err := s.party(meetingID, me, now)
	if err != nil {
		return CallStatus{}, err
	}
	return c.status(peer, now), nil
}

func (c *call) status(peer string, now time.Time) CallStatus {
	st := CallStatus{Peer: peer, EndedBy: c.endedBy}
	if t, ok := c.seen[peer]; ok {
		ms := now.Sub(t).Milliseconds()
		st.PeerSeenMsAgo = &ms
	}
	return st
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
// filtering out anything older than inviteTTL or already hung up (the
// caller gave up before this poll). Polling also counts as presence, so it
// touches lastSeen too.
func (s *Store) DrainInvites(username string) []Invite {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeen[username] = time.Now()

	pending := s.invites[username]
	delete(s.invites, username)

	cutoff := time.Now().Add(-inviteTTL)
	fresh := make([]Invite, 0, len(pending))
	for _, inv := range pending {
		if c, ok := s.calls[inv.MeetingID]; ok && c.endedBy != "" {
			continue
		}
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
