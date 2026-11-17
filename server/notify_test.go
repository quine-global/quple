package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type published struct {
	topic, body, auth, title, priority, click string
}

// newNotifyingApp is newTestApp with call notifications, published to a fake
// ntfy that hands each message to the returned channel.
func newNotifyingApp(t *testing.T) (*httptest.Server, chan published) {
	t.Helper()
	got := make(chan published, 10)
	ntfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got <- published{
			topic: strings.TrimPrefix(r.URL.Path, "/"), body: string(body),
			auth: r.Header.Get("Authorization"), title: r.Header.Get("Title"),
			priority: r.Header.Get("Priority"), click: r.Header.Get("Click"),
		}
	}))
	t.Cleanup(ntfy.Close)
	contacts, err := LoadContacts(filepath.Join(t.TempDir(), "contacts.json"))
	if err != nil {
		t.Fatal(err)
	}
	topics, err := LoadTopics(filepath.Join(t.TempDir(), "topics.json"))
	if err != nil {
		t.Fatal(err)
	}
	app := &App{
		verifier: fakeVerifier{}, store: NewStore(), contacts: contacts,
		defaultJitsiURL: "https://meet.jit.si",
		topics:          topics, notifier: NewNotifier(ntfy.URL, "tk_test"),
	}
	mux := http.NewServeMux()
	app.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, got
}

func next(t *testing.T, got chan published) published {
	t.Helper()
	select {
	case p := <-got:
		return p
	case <-time.After(5 * time.Second):
		t.Fatal("nothing published")
		return published{}
	}
}

func nothing(t *testing.T, got chan published) {
	t.Helper()
	select {
	case p := <-got:
		t.Fatalf("published %+v", p)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestTopicInMe(t *testing.T) {
	srv, _ := newNotifyingApp(t)
	_, a1 := do(t, srv, "alice", "GET", "/me", "")
	_, a2 := do(t, srv, "alice", "GET", "/me", "")
	_, b := do(t, srv, "bob", "GET", "/me", "")
	topic, _ := a1["ntfyTopic"].(string)
	if !strings.HasPrefix(topic, "quple_") || len(topic) < 30 || a1["ntfyServer"] == "" {
		t.Fatalf("/me: %v", a1)
	}
	if a2["ntfyTopic"] != topic || b["ntfyTopic"] == topic {
		t.Fatalf("topics: alice %v then %v, bob %v", topic, a2["ntfyTopic"], b["ntfyTopic"])
	}
	// Without ntfy, no topic.
	plain := newTestApp(t)
	if _, me := do(t, plain, "alice", "GET", "/me", ""); me["ntfyTopic"] != nil {
		t.Fatalf("topic without ntfy: %v", me)
	}
}

func TestNotifiesClosedApp(t *testing.T) {
	srv, got := newNotifyingApp(t)
	_, bob := do(t, srv, "bob", "GET", "/me", "")
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	if call["notified"] != true {
		t.Fatalf("call: %v", call)
	}
	p := next(t, got)
	if p.topic != bob["ntfyTopic"] || p.auth != "Bearer tk_test" || p.priority != "5" || p.click != appURL || !strings.Contains(p.body, "alice is calling") {
		t.Fatalf("published %+v", p)
	}

	// Alice gives up before bob answers: he gets a missed call.
	do(t, srv, "alice", "POST", "/calls/"+call["meetingId"].(string)+"/hangup", "")
	if p = next(t, got); p.topic != bob["ntfyTopic"] || p.body != "Missed call from alice" {
		t.Fatalf("missed call: %+v", p)
	}
}

func TestNoNotificationWhenAppIsOpen(t *testing.T) {
	srv, got := newNotifyingApp(t)
	do(t, srv, "bob", "GET", "/poll", "") // bob's app is open
	if _, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`); call["notified"] != false {
		t.Fatalf("call: %v", call)
	}
	nothing(t, got)
}

func TestNoMissedCallOnceAnswered(t *testing.T) {
	srv, got := newNotifyingApp(t)
	_, call := do(t, srv, "alice", "POST", "/call", `{"to":"bob"}`)
	next(t, got) // "alice is calling"
	path := "/calls/" + call["meetingId"].(string)
	do(t, srv, "bob", "POST", path+"/heartbeat", "") // answered
	do(t, srv, "alice", "POST", path+"/hangup", "")
	nothing(t, got)

	// Nor when the callee declines (his app showed it already).
	_, call = do(t, srv, "carol", "POST", "/call", `{"to":"dave"}`)
	next(t, got)
	do(t, srv, "dave", "POST", "/calls/"+call["meetingId"].(string)+"/hangup", "")
	nothing(t, got)
}
