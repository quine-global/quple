package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// Invite is a pending call: someone tried to reach a user, and it rings
// each of their devices once (PendingInvites) until it's answered, hung up
// or too old.
type Invite struct {
	From      string `json:"from"`
	MeetingID string `json:"meetingId"`
	// JitsiURL is the Jitsi Meet server the caller picked for this call.
	JitsiURL  string    `json:"jitsiUrl"`
	CreatedAt time.Time `json:"createdAt"`
	// delivered: the devices that have been given it ("" for apps that
	// don't say which device they are).
	delivered map[string]bool
	// callerDevice is the device that placed it: in a call to yourself, the
	// one device of yours that doesn't ring.
	callerDevice string
}

// presenceWindow is how long a user is considered "online" after their last
// /register or /poll call. Clients are expected to hit one of those every
// few seconds, so this just needs to comfortably outlast that interval.
const presenceWindow = 90 * time.Second

// inviteTTL bounds how long an invite is kept around: a device that starts
// polling within it (an app opened from the notification) still rings.
const inviteTTL = 2 * time.Minute

// callIdleTTL is how long a call's state is kept after anyone last touched
// it (placed it, sent a heartbeat, hung up).
const callIdleTTL = 10 * time.Minute

var (
	errNoCall     = errors.New("no such call")
	errNotParty   = errors.New("not your call")
	errCallEnded  = errors.New("that call has ended")
	errNeedDevice = errors.New("calling yourself needs your app to say which device it is: update Quple")
	errSelfMove   = errors.New("a call to yourself can't be moved")
)

// Callers and callees: the two sides of a call.
const (
	callerSide = 0
	calleeSide = 1
	noSide     = -1
)

// call is what the server knows about a call while it lasts: its two sides,
// when each last sent a heartbeat from its call screen, and who hung up.
// The apps poll it to end calls whose other side is gone, whatever Jitsi
// server carries the call.
//
// A side is a user and the device their side of the call is on. Between
// two people, the username says which side a request is from. In a call to
// yourself (from your Mac to your iPhone), both are you, and the device
// says it: the caller's device is the caller's side, and the first other
// device to answer is the callee's.
type call struct {
	sides    [2]side
	jitsiURL string
	endedBy  string // who hung up (or declined), "" while the call is on
	endedOn  int    // which side hung up, noSide while the call is on
	touched  time.Time
	// notified: the callee was sent a notification (their app was closed),
	// so a caller giving up sends a "missed call" one too.
	notified bool
}

type side struct {
	user string
	// seen is when this side's call screen last sent a heartbeat (zero: it
	// never has, so a callee who hasn't answered).
	seen time.Time
	// holder is which of the user's devices has this side: the device that
	// placed the call, or the first to send a heartbeat, until another
	// moves it (MoveCall).
	holder *holder
}

func (c *call) self() bool { return c.sides[callerSide].user == c.sides[calleeSide].user }

// recentPollWindow: a user whose app polled (or sent a heartbeat) this
// recently has Quple open, and it rings by itself; no notification.
const recentPollWindow = 10 * time.Second

// holder is the device a side of the call is on.
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

// CallStatus is a call as one of its sides sees it.
type CallStatus struct {
	Peer string `json:"peer"`
	// PeerSeenMsAgo is how long ago the other side last sent a heartbeat;
	// null when it never has (a callee who hasn't answered).
	PeerSeenMsAgo *int64 `json:"peerSeenMsAgo"`
	// EndedBy is who hung up (or declined), "" while the call is on.
	EndedBy string `json:"endedBy"`
	// PeerEnded: the other side hung up or declined. (In a call to
	// yourself, EndedBy is you whichever side it was.)
	PeerEnded bool `json:"peerEnded"`
	// AnsweredOn is set for a device that's ringing when another of yours
	// has answered (its name): stop ringing, without hanging up.
	AnsweredOn string `json:"answeredOn,omitempty"`
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
	invites  map[string][]*Invite
	calls    map[string]*call
}

func NewStore() *Store {
	return &Store{
		lastSeen: make(map[string]time.Time),
		invites:  make(map[string][]*Invite),
		calls:    make(map[string]*call),
	}
}

func (s *Store) Touch(username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeen[username] = time.Now()
}

// PolledRecently reports whether username's app polled within
// recentPollWindow: it's open, and rings for calls by itself.
func (s *Store) PolledRecently(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.lastSeen[username]
	return ok && time.Since(t) < recentPollWindow
}

// MarkNotified records that meetingID's callee was sent a notification.
func (s *Store) MarkNotified(meetingID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.calls[meetingID]; ok {
		c.notified = true
	}
}

// IsOnline reports whether username was seen within presenceWindow.
func (s *Store) IsOnline(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.lastSeen[username]
	return ok && time.Since(t) < presenceWindow
}

// PlaceCall queues inv for every device of to, stamping its creation time,
// and starts the call's state with the caller already in it, on device
// (its name: deviceName) when the app said which it is.
//
// Calls that cross (to is already ringing the caller, who calls them back
// before answering) don't make a second room: the caller answers to's call
// instead, on device, and joined is true. The returned invite is then to's
// (its meeting and Jitsi server). Only for apps that say which device they
// are, and not for calls to yourself.
func (s *Store) PlaceCall(to, device, deviceName string, inv Invite) (_ Invite, joined bool) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepCalls(now)
	if device != "" && to != inv.From {
		if theirs := s.ringingFrom(to, inv.From, now); theirs != nil {
			c := s.calls[theirs.MeetingID]
			c.sides[calleeSide].seen = now
			c.sides[calleeSide].holder = &holder{device: device, name: deviceName, seen: now}
			c.touched = now
			s.lastSeen[inv.From] = now
			return *theirs, true
		}
	}
	inv.CreatedAt = now
	inv.delivered = map[string]bool{}
	inv.callerDevice = device
	s.invites[to] = append(s.invites[to], &inv)
	c := &call{
		sides:    [2]side{{user: inv.From, seen: now}, {user: to}},
		jitsiURL: inv.JitsiURL,
		endedOn:  noSide,
		touched:  now,
	}
	if device != "" {
		c.sides[callerSide].holder = &holder{device: device, name: deviceName, seen: now}
	}
	s.calls[inv.MeetingID] = c
	return inv, false
}

// ringingFrom returns the newest call from `from` still ringing for me (not
// too old, hung up or answered), or nil. Callers hold mu.
func (s *Store) ringingFrom(from, me string, now time.Time) *Invite {
	cutoff := now.Add(-inviteTTL)
	queue := s.invites[me]
	for i := len(queue) - 1; i >= 0; i-- {
		inv := queue[i]
		if inv.From != from || !inv.CreatedAt.After(cutoff) {
			continue
		}
		if c, ok := s.calls[inv.MeetingID]; ok && c.endedBy == "" && c.sides[calleeSide].seen.IsZero() {
			return inv
		}
	}
	return nil
}

// sweepCalls forgets calls nobody has touched in callIdleTTL. Callers hold mu.
func (s *Store) sweepCalls(now time.Time) {
	for id, c := range s.calls {
		if now.Sub(c.touched) > callIdleTTL {
			delete(s.calls, id)
		}
	}
}

// party returns meetingID's call and which side of it me's device is on.
// Between two people that's me's; in a call to yourself, the device
// decides (see call). Callers hold mu.
func (s *Store) party(meetingID, me, device string, now time.Time) (*call, int, error) {
	s.sweepCalls(now)
	c, ok := s.calls[meetingID]
	if !ok {
		return nil, noSide, errNoCall
	}
	if !c.self() {
		switch me {
		case c.sides[callerSide].user:
			return c, callerSide, nil
		case c.sides[calleeSide].user:
			return c, calleeSide, nil
		}
		return nil, noSide, errNotParty
	}
	if me != c.sides[callerSide].user {
		return nil, noSide, errNotParty
	}
	if device == "" {
		return nil, noSide, errNeedDevice
	}
	if h := c.sides[callerSide].holder; h != nil && h.device == device {
		return c, callerSide, nil
	}
	// Any other device of yours is the callee's side: the one that answered,
	// or one still ringing (which sees AnsweredOn once another answers).
	return c, calleeSide, nil
}

// status is the call as a device on side `on` sees it.
func (c *call) status(on int, now time.Time) CallStatus {
	peer := c.sides[1-on]
	st := CallStatus{Peer: peer.user, EndedBy: c.endedBy, PeerEnded: c.endedOn == 1-on}
	if !peer.seen.IsZero() {
		ms := now.Sub(peer.seen).Milliseconds()
		st.PeerSeenMsAgo = &ms
	}
	return st
}

// CallHeartbeat records that me's call screen is up for meetingID on
// hb.Device (which also counts as presence) and returns the call as that
// device sees it. The first device of a side to send one holds that side.
func (s *Store) CallHeartbeat(meetingID, me string, hb Heartbeat) (CallStatus, error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, on, err := s.party(meetingID, me, hb.Device, now)
	if err != nil {
		return CallStatus{}, err
	}
	sd := &c.sides[on]
	sd.seen = now
	c.touched = now
	s.lastSeen[me] = now
	st := c.status(on, now)
	if hb.Device == "" {
		return st, nil
	}
	if sd.holder == nil {
		sd.holder = &holder{device: hb.Device, name: hb.Name}
	}
	if h := sd.holder; h.device == hb.Device {
		h.joined = hb.Joined
		h.seen = now
	} else {
		// Another device has this side: moved there, or (two of your
		// devices answering at once) answered there first.
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
	c, on, err := s.party(meetingID, me, device, now)
	if err != nil {
		return ActiveCall{}, err
	}
	if c.self() {
		return ActiveCall{}, errSelfMove
	}
	if c.endedBy != "" {
		return ActiveCall{}, errCallEnded
	}
	c.sides[on].holder = &holder{device: device, name: name, seen: now}
	c.touched = now
	return ActiveCall{MeetingID: meetingID, Peer: c.sides[1-on].user, JitsiURL: c.jitsiURL, Device: name}, nil
}

// ActiveCalls lists me's calls in progress on a device other than device:
// answered, not hung up, and with a heartbeat from me's side in
// activeWindow. Not calls to yourself (they're on two of your devices
// already).
func (s *Store) ActiveCalls(me, device string) []ActiveCall {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepCalls(now)
	list := []ActiveCall{}
	for id, c := range s.calls {
		if c.self() || c.endedBy != "" {
			continue
		}
		on := noSide
		switch me {
		case c.sides[callerSide].user:
			on = callerSide
		case c.sides[calleeSide].user:
			on = calleeSide
		default:
			continue
		}
		mine, peer := c.sides[on], c.sides[1-on]
		if peer.seen.IsZero() || mine.seen.IsZero() || now.Sub(mine.seen) > activeWindow {
			continue
		}
		name := ""
		if h := mine.holder; h != nil {
			if h.device == device {
				continue
			}
			name = h.name
		}
		list = append(list, ActiveCall{MeetingID: id, Peer: peer.user, JitsiURL: c.jitsiURL, Device: name})
	}
	return list
}

// CallStatus returns meetingID as me's device sees it, without counting as
// a heartbeat: a callee's devices check it while ringing (has the caller
// given up? has another of mine answered?), and a heartbeat would mean
// "answered".
func (s *Store) CallStatus(meetingID, me, device string) (CallStatus, error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, on, err := s.party(meetingID, me, device, now)
	if err != nil {
		return CallStatus{}, err
	}
	st := c.status(on, now)
	if h := c.sides[on].holder; on == calleeSide && h != nil && h.device != device && device != "" {
		st.AnsweredOn = h.name
	}
	return st, nil
}

// HangUp ends meetingID for both sides; the first to hang up is recorded.
// missedBy is set (to the callee) when this was the caller giving up on a
// callee who was notified and never answered: they get a "missed call".
func (s *Store) HangUp(meetingID, me, device string) (missedBy string, err error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, on, err := s.party(meetingID, me, device, now)
	if err != nil {
		return "", err
	}
	if c.endedBy == "" {
		c.endedBy = me
		c.endedOn = on
		if c.notified && on == callerSide && c.sides[calleeSide].seen.IsZero() {
			missedBy = c.sides[calleeSide].user
		}
	}
	c.touched = now
	return missedBy, nil
}

// PendingInvites returns the invites for username that device hasn't been
// given yet, and marks them given: each of a user's devices rings once for
// each call. Not ones too old (inviteTTL), hung up (the caller gave up),
// already answered (on another device), or placed from this device (a call
// to yourself). Apps that don't say which device they are share "".
// Polling also counts as presence, so it touches lastSeen too.
func (s *Store) PendingInvites(username, device string) []Invite {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeen[username] = now

	cutoff := now.Add(-inviteTTL)
	keep := s.invites[username][:0]
	fresh := []Invite{}
	for _, inv := range s.invites[username] {
		c, ok := s.calls[inv.MeetingID]
		if !inv.CreatedAt.After(cutoff) || !ok || c.endedBy != "" || !c.sides[calleeSide].seen.IsZero() {
			continue // gone for every device
		}
		keep = append(keep, inv)
		if inv.delivered[device] || (device != "" && device == inv.callerDevice) {
			continue
		}
		inv.delivered[device] = true
		fresh = append(fresh, *inv)
	}
	if len(keep) == 0 {
		delete(s.invites, username)
	} else {
		s.invites[username] = keep
	}
	return fresh
}

func newMeetingID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return "quple-" + hex.EncodeToString(buf)
}
