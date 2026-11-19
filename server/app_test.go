package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// fakeVerifier treats the bearer token as the caller's subject.
type fakeVerifier struct{}

func (fakeVerifier) Verify(_ context.Context, token string) (string, error) {
	if token == "" || token == "bad" {
		return "", errors.New("invalid")
	}
	return token, nil
}

func newTestApp(t *testing.T) *httptest.Server {
	t.Helper()
	contacts, err := LoadContacts(filepath.Join(t.TempDir(), "contacts.json"))
	if err != nil {
		t.Fatal(err)
	}
	app := &App{
		verifier:        fakeVerifier{},
		store:           NewStore(),
		contacts:        contacts,
		defaultJitsiURL: "https://meet.jit.si",
	}
	mux := http.NewServeMux()
	app.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// do sends a request as `as` (the fake token) and decodes the JSON reply.
func do(t *testing.T, srv *httptest.Server, as, method, path, body string) (int, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, srv.URL+path, r)
	if as != "" {
		req.Header.Set("Authorization", "Bearer "+as)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestAuth(t *testing.T) {
	srv := newTestApp(t)
	if status, _ := do(t, srv, "", "GET", "/me", ""); status != 401 {
		t.Errorf("no token: %d", status)
	}
	if status, _ := do(t, srv, "bad", "GET", "/me", ""); status != 401 {
		t.Errorf("bad token: %d", status)
	}
	status, me := do(t, srv, "alice", "GET", "/me", "")
	if status != 200 || me["username"] != "alice" || me["defaultJitsiUrl"] != "https://meet.jit.si" {
		t.Errorf("/me: %d %v", status, me)
	}
}

func TestCallOnDefaultServer(t *testing.T) {
	srv := newTestApp(t)
	status, call := do(t, srv, "alice", "POST", "/call", `{"to":"Bob"}`)
	if status != 200 || call["jitsiUrl"] != "https://meet.jit.si" || call["meetingId"] == "" {
		t.Fatalf("call: %d %v", status, call)
	}
	_, poll := do(t, srv, "bob", "GET", "/poll", "")
	inv := poll["invites"].([]any)[0].(map[string]any)
	if inv["from"] != "alice" || inv["jitsiUrl"] != "https://meet.jit.si" || inv["meetingId"] != call["meetingId"] {
		t.Fatalf("invite: %v", inv)
	}
}

func TestCallOnAnotherServer(t *testing.T) {
	srv := newTestApp(t)
	// The caller picks any Jitsi; the callee is sent to the same one.
	status, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob","jitsiUrl":"Jitsi.Example.org/"}`)
	if status != 200 || call["jitsiUrl"] != "https://jitsi.example.org" {
		t.Fatalf("call: %d %v", status, call)
	}
	_, poll := do(t, srv, "bob", "GET", "/poll", "")
	inv := poll["invites"].([]any)[0].(map[string]any)
	if inv["jitsiUrl"] != "https://jitsi.example.org" || inv["meetingId"] != call["meetingId"] {
		t.Fatalf("invite: %v", inv)
	}
}

func TestCallValidation(t *testing.T) {
	srv := newTestApp(t)
	for _, tc := range []struct{ body, why string }{
		{`{"to":"alice"}`, "self"},
		{`{"to":"not a name"}`, "malformed name"},
		{`{"to":"bob@example.com"}`, "not a username"},
		{`{"to":"bob","jitsiUrl":"javascript:alert(1)"}`, "non-http server"},
		{`{"to":"bob","jitsiUrl":"file:///etc/passwd"}`, "file server"},
		{`{"to":"bob","jitsiUrl":"https://x.example/?a=b"}`, "query in server"},
		{`{"to":"bob","jitsiUrl":"https://user@x.example"}`, "credentials in server"},
	} {
		if status, _ := do(t, srv, "alice", "POST", "/call", tc.body); status != 400 {
			t.Errorf("%s: status %d", tc.why, status)
		}
	}
}

func TestContacts(t *testing.T) {
	srv := newTestApp(t)
	if status, _ := do(t, srv, "alice", "POST", "/contacts", `{"username":"Joe"}`); status != 200 {
		t.Fatalf("add: %d", status)
	}
	do(t, srv, "alice", "POST", "/contacts", `{"username":"bob"}`)
	if status, _ := do(t, srv, "alice", "POST", "/contacts", `{"username":"alice"}`); status != 400 {
		t.Errorf("adding yourself: %d", status)
	}
	do(t, srv, "joe", "GET", "/poll", "") // joe comes online

	_, list := do(t, srv, "alice", "GET", "/contacts", "")
	got, _ := json.Marshal(list["contacts"])
	want := `[{"online":false,"username":"bob"},{"online":true,"username":"joe"}]`
	if string(got) != want {
		t.Fatalf("contacts = %s, want %s", got, want)
	}

	do(t, srv, "alice", "DELETE", "/contacts/bob", "")
	_, list = do(t, srv, "alice", "GET", "/contacts", "")
	if n := len(list["contacts"].([]any)); n != 1 {
		t.Fatalf("after delete: %d contacts", n)
	}
	// Contact lists are per person.
	_, other := do(t, srv, "bob", "GET", "/contacts", "")
	if n := len(other["contacts"].([]any)); n != 0 {
		t.Fatalf("bob sees %d of alice's contacts", n)
	}
}

func TestCallHeartbeatAndHangUp(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	id := call["meetingId"].(string)
	path := "/calls/" + id

	// The callee hasn't answered: the caller sees them as never seen.
	status, st := do(t, srv, "alice", "POST", path+"/heartbeat", "")
	if status != 200 || st["peer"] != "bob" || st["peerSeenMsAgo"] != nil || st["endedBy"] != "" {
		t.Fatalf("caller before answer: %d %v", status, st)
	}
	// Bob answers: his call screen's heartbeat sees alice, and she him.
	if status, st = do(t, srv, "bob", "POST", path+"/heartbeat", ""); status != 200 || st["peer"] != "alice" || st["peerSeenMsAgo"] == nil {
		t.Fatalf("callee: %d %v", status, st)
	}
	if _, st = do(t, srv, "alice", "POST", path+"/heartbeat", ""); st["peerSeenMsAgo"] == nil {
		t.Fatalf("caller after answer: %v", st)
	}

	// Strangers can't see or end it; unknown calls are 404.
	if status, _ = do(t, srv, "eve", "POST", path+"/heartbeat", ""); status != 403 {
		t.Errorf("stranger heartbeat: %d", status)
	}
	if status, _ = do(t, srv, "eve", "POST", path+"/hangup", ""); status != 403 {
		t.Errorf("stranger hangup: %d", status)
	}
	if status, _ = do(t, srv, "alice", "POST", "/calls/quple-nope/heartbeat", ""); status != 404 {
		t.Errorf("unknown call: %d", status)
	}
	if status, _ = do(t, srv, "alice", "GET", path+"/heartbeat", ""); status != 405 {
		t.Errorf("GET heartbeat: %d", status)
	}

	// Bob hangs up; alice's next heartbeat says so, and a second hangup
	// doesn't change who ended it.
	if status, _ = do(t, srv, "bob", "POST", path+"/hangup", ""); status != 200 {
		t.Fatalf("hangup: %d", status)
	}
	do(t, srv, "alice", "POST", path+"/hangup", "")
	if _, st = do(t, srv, "alice", "POST", path+"/heartbeat", ""); st["endedBy"] != "bob" {
		t.Fatalf("after hangup: %v", st)
	}
}

func TestHeartbeatCountsAsPresence(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	do(t, srv, "bob", "POST", "/calls/"+call["meetingId"].(string)+"/heartbeat", "")
	do(t, srv, "alice", "POST", "/contacts", `{"username":"bob"}`)
	_, list := do(t, srv, "alice", "GET", "/contacts", "")
	if c := list["contacts"].([]any)[0].(map[string]any); c["online"] != true {
		t.Fatalf("bob in a call shows offline: %v", c)
	}
}

func TestRingingAndCancel(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	path := "/calls/" + call["meetingId"].(string)

	// Bob's phone, ringing, checks the call: that isn't answering it.
	if status, st := do(t, srv, "bob", "GET", path, ""); status != 200 || st["peer"] != "alice" || st["endedBy"] != "" {
		t.Fatalf("callee status: %d %v", status, st)
	}
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", ""); st["peerSeenMsAgo"] != nil {
		t.Fatalf("checking the call counted as answering: %v", st)
	}
	if status, _ := do(t, srv, "eve", "GET", path, ""); status != 403 {
		t.Errorf("stranger status: %d", status)
	}

	// Alice gives up; bob's ringing phone sees it.
	do(t, srv, "alice", "POST", path+"/hangup", "")
	if _, st := do(t, srv, "bob", "GET", path, ""); st["endedBy"] != "alice" {
		t.Fatalf("after cancel: %v", st)
	}
}

func TestCancelledCallIsNotDelivered(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	do(t, srv, "alice", "POST", "/calls/"+call["meetingId"].(string)+"/hangup", "")
	// Bob's app polls only now: there's nothing to ring for.
	if _, poll := do(t, srv, "bob", "GET", "/poll", ""); len(poll["invites"].([]any)) != 0 {
		t.Fatalf("cancelled call delivered: %v", poll)
	}
}

func TestMoveCallBetweenDevices(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	id := call["meetingId"].(string)
	path := "/calls/" + id
	phone := `{"device":"alice-phone","name":"iPhone","joined":true}`

	// Alice talks on her iPhone; bob answers.
	do(t, srv, "alice", "POST", path+"/heartbeat", phone)
	do(t, srv, "bob", "POST", path+"/heartbeat", `{"device":"bob-phone","name":"iPhone","joined":true}`)

	// Her Mac sees the call on her iPhone; the iPhone doesn't see its own.
	_, poll := do(t, srv, "alice", "GET", "/poll?device=alice-mac", "")
	calls := poll["calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("mac sees %v", poll)
	}
	if c := calls[0].(map[string]any); c["meetingId"] != id || c["peer"] != "bob" || c["device"] != "iPhone" || c["jitsiUrl"] != "https://meet.jit.si" {
		t.Fatalf("active call: %v", c)
	}
	if _, poll = do(t, srv, "alice", "GET", "/poll?device=alice-phone", ""); len(poll["calls"].([]any)) != 0 {
		t.Fatalf("phone sees its own call: %v", poll)
	}
	// Nor does bob's iPhone see his own side.
	if _, poll = do(t, srv, "bob", "GET", "/poll?device=bob-phone", ""); len(poll["calls"].([]any)) != 0 {
		t.Fatalf("bob's phone sees its own call: %v", poll)
	}

	// The Mac takes it. Until it's joined, the iPhone is told to mute only.
	if status, moved := do(t, srv, "alice", "POST", path+"/move", `{"device":"alice-mac","name":"Mac"}`); status != 200 || moved["jitsiUrl"] != "https://meet.jit.si" || moved["peer"] != "bob" {
		t.Fatalf("move: %d %v", status, moved)
	}
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", phone); st["movedTo"] != "Mac" || st["movedJoined"] == true {
		t.Fatalf("phone before the mac joined: %v", st)
	}
	do(t, srv, "alice", "POST", path+"/heartbeat", `{"device":"alice-mac","name":"Mac","joined":true}`)
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", phone); st["movedTo"] != "Mac" || st["movedJoined"] != true {
		t.Fatalf("phone after the mac joined: %v", st)
	}
	// The Mac isn't told to move anywhere, and now the iPhone sees the call
	// on the Mac (to take back).
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", `{"device":"alice-mac","name":"Mac","joined":true}`); st["movedTo"] != nil {
		t.Fatalf("mac told to move: %v", st)
	}
	if _, poll = do(t, srv, "alice", "GET", "/poll?device=alice-phone", ""); len(poll["calls"].([]any)) != 1 {
		t.Fatalf("phone doesn't see the call on the mac: %v", poll)
	}

	// Bob can't move alice's side; nobody can move an ended call; a move
	// needs a device.
	if status, _ := do(t, srv, "eve", "POST", path+"/move", `{"device":"x","name":"x"}`); status != 403 {
		t.Errorf("stranger move: %d", status)
	}
	if status, _ := do(t, srv, "alice", "POST", path+"/move", `{}`); status != 400 {
		t.Errorf("move without a device: %d", status)
	}
	do(t, srv, "bob", "POST", path+"/hangup", "")
	if status, _ := do(t, srv, "alice", "POST", path+"/move", `{"device":"alice-phone","name":"iPhone"}`); status != 409 {
		t.Errorf("moving an ended call: %d", status)
	}
	if _, poll = do(t, srv, "alice", "GET", "/poll?device=alice-phone", ""); len(poll["calls"].([]any)) != 0 {
		t.Fatalf("ended call still offered: %v", poll)
	}
}

func TestUnansweredCallIsNotOffered(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	do(t, srv, "alice", "POST", "/calls/"+call["meetingId"].(string)+"/heartbeat", `{"device":"alice-phone","name":"iPhone"}`)
	// Still ringing: nothing to move to the Mac yet.
	if _, poll := do(t, srv, "alice", "GET", "/poll?device=alice-mac", ""); len(poll["calls"].([]any)) != 0 {
		t.Fatalf("ringing call offered: %v", poll)
	}
	// /poll without a device is as before.
	if _, poll := do(t, srv, "alice", "GET", "/poll", ""); poll["calls"] != nil {
		t.Fatalf("calls without a device: %v", poll)
	}
}

func TestEveryDeviceRingsAndHearsWhereItWasAnswered(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob","device":"alice-mac","name":"Mac"}`)
	id := call["meetingId"].(string)

	// Both of bob's devices ring, each once.
	for _, device := range []string{"bob-phone", "bob-mac"} {
		_, poll := do(t, srv, "bob", "GET", "/poll?device="+device, "")
		if invites := poll["invites"].([]any); len(invites) != 1 || invites[0].(map[string]any)["meetingId"] != id {
			t.Fatalf("%s: %v", device, poll)
		}
		if _, poll = do(t, srv, "bob", "GET", "/poll?device="+device, ""); len(poll["invites"].([]any)) != 0 {
			t.Fatalf("%s rings twice: %v", device, poll)
		}
	}

	// Answered on the iPhone: the Mac, still ringing, hears it and stops
	// (it's not a hang-up); the iPhone doesn't hear it about itself.
	do(t, srv, "bob", "POST", "/calls/"+id+"/heartbeat", `{"device":"bob-phone","name":"iPhone"}`)
	if _, st := do(t, srv, "bob", "GET", "/calls/"+id+"?device=bob-mac", ""); st["answeredOn"] != "iPhone" || st["endedBy"] != "" || st["peerEnded"] != false {
		t.Fatalf("mac while ringing: %v", st)
	}
	if _, st := do(t, srv, "bob", "GET", "/calls/"+id+"?device=bob-phone", ""); st["answeredOn"] != nil {
		t.Fatalf("phone told it was answered elsewhere: %v", st)
	}
	// Alice sees the answer.
	if _, st := do(t, srv, "alice", "POST", "/calls/"+id+"/heartbeat", `{"device":"alice-mac","name":"Mac"}`); st["peerSeenMsAgo"] == nil {
		t.Fatalf("caller doesn't see the answer: %v", st)
	}
}

func TestCallYourself(t *testing.T) {
	srv := newTestApp(t)
	// Not without saying which device: that's how the sides are told apart.
	if status, _ := do(t, srv, "alice", "POST", "/call", `{"to":"alice"}`); status != 400 {
		t.Fatalf("self call without a device: %d", status)
	}
	status, call := do(t, srv, "alice", "POST", "/call", `{"to":"alice","device":"alice-mac","name":"Mac"}`)
	if status != 200 {
		t.Fatalf("self call: %d %v", status, call)
	}
	id := call["meetingId"].(string)
	path := "/calls/" + id
	mac := `{"device":"alice-mac","name":"Mac","joined":true}`
	phone := `{"device":"alice-phone","name":"iPhone","joined":true}`

	// The Mac that placed it doesn't ring; the iPhone does.
	if _, poll := do(t, srv, "alice", "GET", "/poll?device=alice-mac", ""); len(poll["invites"].([]any)) != 0 {
		t.Fatalf("calling device rings: %v", poll)
	}
	if _, poll := do(t, srv, "alice", "GET", "/poll?device=alice-phone", ""); len(poll["invites"].([]any)) != 1 {
		t.Fatalf("other device doesn't ring: %v", poll)
	}
	// Nor is it offered to move (it's on both of your devices already).
	if _, poll := do(t, srv, "alice", "GET", "/poll?device=alice-ipad", ""); len(poll["calls"].([]any)) != 0 {
		t.Fatalf("self call offered to move: %v", poll)
	}

	// Ringing: the Mac sees nobody yet. The iPhone answers; each sees the other.
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", mac); st["peerSeenMsAgo"] != nil || st["peer"] != "alice" {
		t.Fatalf("mac while ringing: %v", st)
	}
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", phone); st["peerSeenMsAgo"] == nil || st["movedTo"] != nil {
		t.Fatalf("phone after answering: %v", st)
	}
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", mac); st["peerSeenMsAgo"] == nil || st["movedTo"] != nil {
		t.Fatalf("mac after the answer: %v", st)
	}
	if status, _ := do(t, srv, "alice", "POST", path+"/move", `{"device":"alice-ipad","name":"iPad"}`); status != 409 {
		t.Errorf("moving a self call: %d", status)
	}

	// The iPhone hangs up: the Mac sees the other side gone, the iPhone
	// doesn't see itself as the other side.
	do(t, srv, "alice", "POST", path+"/hangup", `{"device":"alice-phone"}`)
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", mac); st["peerEnded"] != true || st["endedBy"] != "alice" {
		t.Fatalf("mac after the phone hung up: %v", st)
	}
	if _, st := do(t, srv, "alice", "POST", path+"/heartbeat", phone); st["peerEnded"] != false {
		t.Fatalf("phone after hanging up: %v", st)
	}
}

func TestHangUpTellsThePeer(t *testing.T) {
	srv := newTestApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	id := call["meetingId"].(string)
	do(t, srv, "bob", "POST", "/calls/"+id+"/hangup", "")
	if _, st := do(t, srv, "alice", "GET", "/calls/"+id, ""); st["peerEnded"] != true || st["endedBy"] != "bob" {
		t.Fatalf("caller after bob declined: %v", st)
	}
	if _, st := do(t, srv, "bob", "GET", "/calls/"+id, ""); st["peerEnded"] != false {
		t.Fatalf("bob after declining: %v", st)
	}
}

func TestCrossedCallsShareOneRoom(t *testing.T) {
	srv := newTestApp(t)
	_, first := do(t, srv, "alice", "POST", "/call", `{"to":"bob","jitsiUrl":"https://jitsi.example.org","device":"alice-mac","name":"Mac"}`)
	id := first["meetingId"].(string)
	// Bob's Mac has started ringing; his iPhone hasn't polled yet.
	do(t, srv, "bob", "GET", "/poll?device=bob-mac", "")

	// Bob calls Alice before answering: he's in her call, not a new one.
	_, second := do(t, srv, "bob", "POST", "/call", `{"to":"alice","device":"bob-mac","name":"Mac"}`)
	if second["joined"] != true || second["meetingId"] != id || second["jitsiUrl"] != "https://jitsi.example.org" {
		t.Fatalf("crossed call: %v", second)
	}
	// Nobody rings for it: not Alice, nor Bob's iPhone.
	if _, poll := do(t, srv, "alice", "GET", "/poll?device=alice-phone", ""); len(poll["invites"].([]any)) != 0 {
		t.Fatalf("alice rings: %v", poll)
	}
	if _, poll := do(t, srv, "bob", "GET", "/poll?device=bob-phone", ""); len(poll["invites"].([]any)) != 0 {
		t.Fatalf("bob's iPhone rings: %v", poll)
	}
	// Alice's ringing screen sees the answer; Bob's other device hears
	// where it was answered; Bob's own device is the callee's side.
	if _, st := do(t, srv, "alice", "POST", "/calls/"+id+"/heartbeat", `{"device":"alice-mac","name":"Mac"}`); st["peerSeenMsAgo"] == nil {
		t.Fatalf("alice doesn't see the answer: %v", st)
	}
	if _, st := do(t, srv, "bob", "GET", "/calls/"+id+"?device=bob-phone", ""); st["answeredOn"] != "Mac" {
		t.Fatalf("bob's iPhone: %v", st)
	}
	if _, st := do(t, srv, "bob", "POST", "/calls/"+id+"/heartbeat", `{"device":"bob-mac","name":"Mac"}`); st["peer"] != "alice" || st["movedTo"] != nil {
		t.Fatalf("bob in the call: %v", st)
	}
}

func TestCallingBackAfterAHangUpRings(t *testing.T) {
	srv := newTestApp(t)
	_, first := do(t, srv, "alice", "POST", "/call", `{"to":"bob","device":"alice-mac","name":"Mac"}`)
	id := first["meetingId"].(string)
	do(t, srv, "alice", "POST", "/calls/"+id+"/hangup", `{"device":"alice-mac"}`)

	// Alice gave up: Bob calling back is a new call, and it rings.
	_, second := do(t, srv, "bob", "POST", "/call", `{"to":"alice","device":"bob-mac","name":"Mac"}`)
	if second["joined"] != nil || second["meetingId"] == id {
		t.Fatalf("joined a hung-up call: %v", second)
	}
	if _, poll := do(t, srv, "alice", "GET", "/poll?device=alice-phone", ""); len(poll["invites"].([]any)) != 1 {
		t.Fatalf("alice doesn't ring: %v", poll)
	}
}
