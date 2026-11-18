package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// withCORS allows any origin: the desktop webview calls this server as a
// cross-origin fetch, and auth is a bearer token rather than cookies, so
// there's no ambient credential for another origin to ride on.
func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

// tokenVerifier checks a Quine access token and returns its subject (the
// caller's username). *Verifier is the real one; tests substitute a fake.
type tokenVerifier interface {
	Verify(ctx context.Context, token string) (string, error)
}

// App is the signaling service: presence, calls and contacts for everyone
// with a Quine account.
type App struct {
	verifier tokenVerifier
	store    *Store
	contacts *Contacts
	// defaultJitsiURL hosts calls that don't name a server.
	defaultJitsiURL string
	// Call notifications for people whose app is closed (ntfy); optional.
	topics   *Topics
	notifier *Notifier
}

// appURL opens Quple on the iPhone (Info.plist's URL scheme): a
// notification's tap action. Quple then polls and rings as usual.
const appURL = "com.quineglobal.quple://call"

func (a *App) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/me", withCORS(a.requireAuth(a.handleMe)))
	mux.HandleFunc("/register", withCORS(a.requireAuth(a.handleRegister)))
	mux.HandleFunc("/poll", withCORS(a.requireAuth(a.handlePoll)))
	mux.HandleFunc("/call", withCORS(a.requireAuth(a.handleCall)))
	mux.HandleFunc("/calls/{id}", withCORS(a.requireAuth(a.handleCallStatus)))
	mux.HandleFunc("/calls/{id}/heartbeat", withCORS(a.requireAuth(a.handleHeartbeat)))
	mux.HandleFunc("/calls/{id}/hangup", withCORS(a.requireAuth(a.handleHangUp)))
	mux.HandleFunc("/calls/{id}/move", withCORS(a.requireAuth(a.handleMove)))
	mux.HandleFunc("/contacts", withCORS(a.requireAuth(a.handleContacts)))
	mux.HandleFunc("/contacts/{username}", withCORS(a.requireAuth(a.handleContact)))
}

// authedHandler is a handler that knows who's calling.
type authedHandler func(w http.ResponseWriter, r *http.Request, me string)

// requireAuth rejects requests without a valid Quine access token and passes
// the token's username to h. Usernames always come from the token, never
// from the request, so nobody can act as someone else.
func (a *App) requireAuth(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, "sign in required")
			return
		}
		username, err := a.verifier.Verify(r.Context(), token)
		if errors.Is(err, errIdentityUnavailable) {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
			writeError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}
		h(w, r, username)
	}
}

// handleMe tells the app who it's signed in as, and which Jitsi calls use
// unless the caller picks another. GET
func (a *App) handleMe(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	body := map[string]string{"username": me, "defaultJitsiUrl": a.defaultJitsiURL}
	// Where to subscribe (the ntfy app) for calls while Quple is closed.
	if a.notifier.Enabled() {
		topic, err := a.topics.Get(me)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not make a notification topic")
			return
		}
		body["ntfyServer"] = a.notifier.url
		body["ntfyTopic"] = topic
	}
	writeJSON(w, http.StatusOK, body)
}

// handleRegister announces/refreshes the caller's presence. POST
func (a *App) handleRegister(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	a.store.Touch(me)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handlePoll returns the calls ringing for the caller that this device
// hasn't rung for yet (every device of yours rings), and counts as
// presence. GET /poll[?device=...]
func (a *App) handlePoll(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	device := r.URL.Query().Get("device")
	body := map[string]any{"invites": a.store.PendingInvites(me, device)}
	// With ?device=, also your calls on your other devices, to move here.
	if device != "" {
		body["calls"] = a.store.ActiveCalls(me, device)
	}
	writeJSON(w, http.StatusOK, body)
}

// handleCall starts a call from the caller to another user (all of whose
// devices ring), or to themselves (their other devices ring), on whichever
// Jitsi Meet server the caller picks (the default if none). Jitsi servers
// don't need any credentials from us: both sides just open the same room.
// POST {"to": "bob", "jitsiUrl": "https://meet.jit.si", "device": "...", "name": "Mac"}
func (a *App) handleCall(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		To       string `json:"to"`
		JitsiURL string `json:"jitsiUrl"`
		// The calling device (optional, but needed to call yourself).
		Device string `json:"device"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	to, err := normalizeUsername(body.To)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if to == me && body.Device == "" {
		writeError(w, http.StatusBadRequest, errNeedDevice.Error())
		return
	}
	jitsiURL := a.defaultJitsiURL
	if body.JitsiURL != "" {
		if jitsiURL, err = normalizeJitsiURL(body.JitsiURL); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	a.store.Touch(me)
	inv := a.store.PlaceCall(to, body.Device, body.Name, Invite{From: me, MeetingID: newMeetingID(), JitsiURL: jitsiURL})
	// Their app is closed (it hasn't polled lately): a notification, so they
	// can open it and answer. The caller's app then rings for longer.
	notified := false
	if a.notifier.Enabled() && !a.store.PolledRecently(to) {
		if topic, err := a.topics.Get(to); err == nil {
			a.notifier.Send(topic, Notification{
				Title:    "Quple",
				Message:  me + " is calling. Open Quple to answer.",
				Click:    appURL,
				Tags:     "telephone_receiver",
				Priority: "5",
			})
			a.store.MarkNotified(inv.MeetingID)
			notified = true
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"meetingId": inv.MeetingID, "jitsiUrl": jitsiURL, "notified": notified})
}

// writeCallError answers for a call the caller can't touch.
func writeCallError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoCall):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, errNotParty):
		writeError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, errNeedDevice):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, errCallEnded), errors.Is(err, errSelfMove):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// handleHeartbeat is sent every few seconds from a call screen: "I'm still
// in this call". It answers with the other side's last heartbeat and
// whether anyone hung up, so an app can end a call whose other side is
// gone. POST /calls/{id}/heartbeat
func (a *App) handleHeartbeat(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	// The body says which device this is (optional: older apps send none).
	var hb Heartbeat
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&hb); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}
	st, err := a.store.CallHeartbeat(r.PathValue("id"), me, hb)
	if err != nil {
		writeCallError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleCallStatus is the call as the caller's device sees it, without
// counting as a heartbeat (answering): for a device that's still ringing.
// GET /calls/{id}[?device=...]
func (a *App) handleCallStatus(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	st, err := a.store.CallStatus(r.PathValue("id"), me, r.URL.Query().Get("device"))
	if err != nil {
		writeCallError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleMove moves your side of a call to the device sending this: its
// other device leaves once this one has joined the room. Answers with the
// call, to join. POST /calls/{id}/move {"device": "...", "name": "Mac"}
func (a *App) handleMove(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		Device string `json:"device"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Device == "" {
		writeError(w, http.StatusBadRequest, `need {"device": ..., "name": ...}`)
		return
	}
	ac, err := a.store.MoveCall(r.PathValue("id"), me, body.Device, body.Name)
	if err != nil {
		writeCallError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ac)
}

// handleHangUp ends a call for both sides (hanging up, or declining an
// incoming call). POST /calls/{id}/hangup [{"device": "..."}]: the device
// says which side hangs up in a call to yourself.
func (a *App) handleHangUp(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		Device string `json:"device"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}
	missedBy, err := a.store.HangUp(r.PathValue("id"), me, body.Device)
	if err != nil {
		writeCallError(w, err)
		return
	}
	if missedBy != "" {
		if topic, err := a.topics.Get(missedBy); err == nil {
			a.notifier.Send(topic, Notification{
				Title:   "Quple",
				Message: "Missed call from " + me,
				Click:   appURL,
				Tags:    "telephone_receiver",
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type contact struct {
	Username string `json:"username"`
	Online   bool   `json:"online"`
}

// handleContacts lists the caller's contacts with presence (GET), or adds
// one (POST {"username": "bob"}).
func (a *App) handleContacts(w http.ResponseWriter, r *http.Request, me string) {
	switch r.Method {
	case http.MethodGet:
		list := []contact{}
		for _, name := range a.contacts.List(me) {
			list = append(list, contact{Username: name, Online: a.store.IsOnline(name)})
		}
		writeJSON(w, http.StatusOK, map[string][]contact{"contacts": list})
	case http.MethodPost:
		var body struct {
			Username string `json:"username"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		name, err := normalizeUsername(body.Username)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if name == me {
			writeError(w, http.StatusBadRequest, "that's you")
			return
		}
		if err := a.contacts.Add(me, name); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, contact{Username: name, Online: a.store.IsOnline(name)})
	default:
		writeError(w, http.StatusMethodNotAllowed, "GET or POST only")
	}
}

// handleContact removes one contact. DELETE /contacts/{username}
func (a *App) handleContact(w http.ResponseWriter, r *http.Request, me string) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "DELETE only")
		return
	}
	name, err := normalizeUsername(r.PathValue("username"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.contacts.Remove(me, name); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save contacts")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
