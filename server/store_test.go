package main

import (
	"testing"
	"time"
)

func TestPlaceCallRingsEachDeviceOnce(t *testing.T) {
	s := NewStore()

	inv, _ := s.PlaceCall("bob", "alice-mac", "Mac", Invite{From: "alice", MeetingID: newMeetingID()})
	if inv.CreatedAt.IsZero() {
		t.Fatal("CreatedAt not set")
	}

	// Each of bob's devices gets it, once.
	for _, device := range []string{"bob-phone", "bob-mac"} {
		got := s.PendingInvites("bob", device)
		if len(got) != 1 || got[0].MeetingID != inv.MeetingID {
			t.Fatalf("%s: PendingInvites = %+v, want one invite with meetingId %q", device, got, inv.MeetingID)
		}
		if got := s.PendingInvites("bob", device); len(got) != 0 {
			t.Fatalf("%s: again = %+v, want empty", device, got)
		}
	}

	// Once one answers, a device that hasn't polled yet doesn't ring.
	if _, err := s.CallHeartbeat(inv.MeetingID, "bob", Heartbeat{Device: "bob-phone", Name: "iPhone"}); err != nil {
		t.Fatal(err)
	}
	if got := s.PendingInvites("bob", "bob-ipad"); len(got) != 0 {
		t.Fatalf("answered call still rings: %+v", got)
	}
}

func TestMeetingIDsAreDistinct(t *testing.T) {
	if newMeetingID() == newMeetingID() {
		t.Fatal("two meeting IDs collided")
	}
}

func TestPresence(t *testing.T) {
	s := NewStore()
	if s.IsOnline("bob") {
		t.Fatal("unknown user reported online")
	}
	s.PendingInvites("bob", "") // polling counts as presence
	if !s.IsOnline("bob") {
		t.Fatal("polling user not reported online")
	}
}

func TestIdleCallsAreForgotten(t *testing.T) {
	s := NewStore()
	inv, _ := s.PlaceCall("bob", "", "", Invite{From: "alice", MeetingID: newMeetingID()})
	s.calls[inv.MeetingID].touched = time.Now().Add(-callIdleTTL - time.Second)
	if _, err := s.CallHeartbeat(inv.MeetingID, "alice", Heartbeat{}); err != errNoCall {
		t.Fatalf("heartbeat on an idle call: %v, want errNoCall", err)
	}
}
