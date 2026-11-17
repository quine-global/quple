package main

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"
)

// Notifier publishes call notifications to ntfy (NTFY_URL, NTFY_TOKEN): our
// own server, where only Quple may publish, and only to quple_* topics. The
// ntfy app on the callee's phone shows them even when Quple is closed. With
// no NTFY_URL it does nothing.
type Notifier struct {
	url    string // e.g. https://ntfy.quineglobal.com
	token  string
	client *http.Client
}

func NewNotifier(url, token string) *Notifier {
	return &Notifier{url: strings.TrimRight(url, "/"), token: token, client: &http.Client{Timeout: 10 * time.Second}}
}

func (n *Notifier) Enabled() bool { return n != nil && n.url != "" }

// Notification is one ntfy message. Click is a URL opened when it's tapped.
type Notification struct {
	Title, Message, Click, Tags string
	Priority                    string // ntfy's 1-5; 5 is urgent
}

// Send publishes m to topic in the background: a slow or failing ntfy
// never holds up the call.
func (n *Notifier) Send(topic string, m Notification) {
	if !n.Enabled() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.url+"/"+topic, strings.NewReader(m.Message))
		if err != nil {
			log.Printf("ntfy: %v", err)
			return
		}
		if n.token != "" {
			req.Header.Set("Authorization", "Bearer "+n.token)
		}
		for k, v := range map[string]string{"Title": m.Title, "Click": m.Click, "Tags": m.Tags, "Priority": m.Priority} {
			if v != "" {
				req.Header.Set(k, v)
			}
		}
		resp, err := n.client.Do(req)
		if err != nil {
			log.Printf("ntfy: %v", err)
			return
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			log.Printf("ntfy: publishing to %s: HTTP %d", topic, resp.StatusCode)
		}
	}()
}
