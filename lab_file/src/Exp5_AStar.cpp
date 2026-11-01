// 8-Puzzle using A* search
// f(n) = g(n) + h(n),  g = moves made so far,  h = misplaced tiles
#include <iostream>
#include <string>
#include <queue>
#include <set>
#include <map>
#include <algorithm>
using namespace std;

const string GOAL = "123804765";

int misplaced(const string &s) {
    int cnt = 0;
    for (int i = 0; i < 9; i++)
        if (s[i] != '0' && s[i] != GOAL[i]) cnt++;
    return cnt;
}

struct State {
    string board;
    int g, h;
    int f() const { return g + h; }
    bool operator>(const State &o) const {        // min-heap on f, then h
        return f() != o.f() ? f() > o.f() : h > o.h;
    }
};

void print(const string &s) {
    for (int i = 0; i < 9; i++) {
        cout << (s[i] == '0' ? '_' : s[i]) << (i % 3 == 2 ? "\n" : " ");
    }
}

int main() {
    string start = "283164705";
    priority_queue<State, vector<State>, greater<State>> open;
    set<string> closed;
    map<string, string> par;
    map<string, int> bestG;
    open.push({start, 0, misplaced(start)});
    par[start] = "";
    bestG[start] = 0;
    int step = 0;

    while (!open.empty()) {
        State cur = open.top(); open.pop();
        if (closed.count(cur.board)) continue;
        closed.insert(cur.board);
        cout << "Expanding #" << ++step << "   g=" << cur.g << "  h=" << cur.h
             << "  f=" << cur.f() << "\n";
        print(cur.board);

        if (cur.board == GOAL) {
            vector<string> path;
            for (string x = GOAL; x != ""; x = par[x]) path.push_back(x);
            reverse(path.begin(), path.end());
            cout << "\nGoal reached!  Nodes expanded = " << step
                 << ",  solution length = " << cur.g << " moves\n";
            cout << "Path :";
            for (auto &p : path) cout << " " << p;
            cout << "\n";
            return 0;
        }
        int b = cur.board.find('0'), r = b / 3, c = b % 3;
        int dr[] = {-1, 1, 0, 0}, dc[] = {0, 0, -1, 1};
        for (int k = 0; k < 4; k++) {
            int nr = r + dr[k], nc = c + dc[k];
            if (nr < 0 || nr > 2 || nc < 0 || nc > 2) continue;
            string nb = cur.board;
            swap(nb[b], nb[nr * 3 + nc]);
            if (closed.count(nb)) continue;
            if (bestG.count(nb) && bestG[nb] <= cur.g + 1) continue;
            bestG[nb] = cur.g + 1;
            par[nb] = cur.board;
            open.push({nb, cur.g + 1, misplaced(nb)});
        }
    }
    return 0;
}
