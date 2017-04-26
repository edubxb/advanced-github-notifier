/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/* global redirectUri */
//TODO make the URIs overridable for Enterprise
//TODO replace redirectUri with identity API (blocked by 53 being stable)

const parseLinks = (links) => {
    const linkInfo = links.split(",");
    const linkObj = {};
    linkInfo.forEach((link) => {
        const matches = link.match(/<([^>]+)>;\s+rel="([^"]+)"/);
        if(matches && matches.length >= 3) {
            linkObj[matches[2]] = matches[1];
        }
    });
    return linkObj;
};

class GitHub {
    static get BASE_URI() {
        return 'https://api.github.com/';
    }

    static get SITE_URI() {
        return 'https://github.com/';
    }

    static get REDIRECT_URI() {
        return new URL(redirectUri);
    }

    static get SCOPE() {
        return "repo";
    }

    static get ALL_NOTIFS_URL() {
        return `${GitHub.SITE_URI}notifications?all=1`;
    }

    constructor(clientID, clientSecret) {
        this.clientID = clientID;
        this.clientSecret = clientSecret;
        this.lastUpdate = null;
        this.forceRefresh = false;
        this.pollInterval = 60;
        this.headers = {
            Accept: "application/vnd.github.v3+json"
        };
    }

    get authorized() {
        return "Authorization" in this.headers;
    }

    get infoURL() {
        return `${GitHub.SITE_URI}settings/connections/applications/${this.clientID}`;
    }

    authURL(authState) {
        return `${GitHub.SITE_URI}login/oauth/authorize?client_id=${this.clientID}&scope=${GitHub.SCOPE}&state=${authState}&redirect_uri=${GitHub.REDIRECT_URI.toString()}`;
    }

    setToken(token) {
        this.headers.Authorization = `token ${token}`;
    }

    async getToken(code, authState) {
        const params = new URLSearchParams();
        params.append("client_id", this.clientID);
        params.append("client_secret", this.clientSecret);
        params.append("code", code);
        params.append("redirect_uri", GitHub.REDIRECT_URI.toString());
        params.append("state", authState);

        const response = await fetch(`${GitHub.SITE_URI}login/oauth/access_token`, {
            method: "POST",
            body: params,
            headers: {
                Accept: "application/json"
            }
        });
        //TODO requeue on network errors
        if(response.ok) {
            const { access_token: accessToken, scope } = await response.json();
            if(!scope.includes(GitHub.SCOPE)) {
                throw "Was not granted required permissions";
            }
            else {
                this.setToken(accessToken);
                return accessToken;
            }
        }
        else {
            throw response;
        }
    }

    async authorize(token, method = "GET") {
        const response = await fetch(`${GitHub.BASE_URI}applications/${this.clientID}/tokens/${token}`, {
            method,
            headers: {
                Authorization: `Basic ${window.btoa(this.clientID + ":" + this.clientSecret)}`
            }
        });
        if(method == "GET") {
            if(response.status === 200) {
                const json = await response.json();
                if(json.scopes.includes(GitHub.SCOPE)) {
                    this.setToken(token);
                    return true;
                }
                else {
                    throw "Not all required scopes given";
                }
            }
            else {
                throw "Token invalid";
            }
        }
        return "Token updated";
    }

    deauthorize(token) {
        return this.authorize(token, "DELETE");
    }

    async markNotificationsRead() {
        if(this.lastUpdate !== null && this.authorized) {
            const body = JSON.stringify({ "last_read_at": this.lastUpdate });
            const response = await fetch(`${GitHub.BASE_URI}notifications`, {
                headers: this.headers,
                method: "PUT",
                body
            });
            if(response.status == 205) {
                browser.runtime.sendMessage({
                    target: "all-notifications-read"
                });
                return true;
            }
            else {
                throw `Marking all notifications read returned a ${response.status} error`;
            }
        }
        return false;
    }

    async markNotificationRead(notificationID) {
        const response = await fetch(`${GitHub.BASE_URI}notifications/threads/${notificationID}`, {
            method: "PATCH",
            headers: this.headers
        });
        if(response.ok) {
            browser.runtime.sendMessage({
                target: "notification-read",
                notificationId: notificationID
            });
        }
        else {
            throw response.status;
        }
    }

    async getNotifications(url = `${GitHub.BASE_URI}notifications`) {
        const response = await fetch(url, {
            headers: this.headers,
            // Have to bypass cache when there are notifications, as the Etag doesn't
            // change when notifications are read.
            cache: this.forceRefresh ? "reload" : "no-cache"
        });

        if(response.ok) {
            this.pollInterval = Math.max(
                response.headers.get("X-Poll-Interval"),
                Math.ceil((response.headers.get("X-RateLimit-Reset") - Math.floor(Date.now() / 1000)) / response.headers.get("X-RateLimit-Remaining"))
            );

            const now = new Date();
            this.lastUpdate = now.toISOString();

            if(response.status === 200) {
                const json = await response.json();

                // There is some pagination here.
                if(response.headers.has('Link')) {
                    const links = parseLinks(response.headers.get('Link'));
                    if("next" in links) {
                        // get next page
                        const nextPage = await this.getNotifications(links.next);
                        this.forceRefresh = json.length > 0;
                        return json.concat(nextPage);
                    }
                }
                this.forceRefresh = json.length > 0;
                return json;
            }
            return false;
        }
        else {
            throw `${response.status} ${response.statusText}`;
        }
    }

    async getNotificationDetails(notification) {
        const apiEndpoint = notification.subject.url;
        const response = await fetch(apiEndpoint, {
            headers: this.headers
        });
        if(response.ok) {
            return response.json();
        }
        else {
            throw `Could not load details for ${notification.subject.title}: Error ${response.status}`;
        }
    }
}