// 8-Puzzle using Generate and Test strategy
// Generator : produces new board configurations level by level
// Tester    : checks whether a generated board equals the goal board
#include <iostream>
#include <string>
#include <queue>
#include <map>
#include <algorithm>
using namespace std;

const string GOAL = "123804765";     // '0' denotes the blank tile

void showBoard(const string &s) {
    for (int r = 0; r < 3; r++) {
        for (int c = 0; c < 3; c++) {
            char t = s[r * 3 + c];
            cout << (t == '0' ? '_' : t) << " ";
        }
        cout << "\n";
    }
}

// GENERATE : all boards reachable from s by sliding one tile into the blank
vector<pair<string, char>> generate(const string &s) {
    vector<pair<string, char>> children;
    int b = s.find('0');
    int r = b / 3, c = b % 3;
    int dr[] = {-1, 1, 0, 0};
    int dc[] = {0, 0, -1, 1};
    char mv[] = {'U', 'D', 'L', 'R'};
    for (int k = 0; k < 4; k++) {
        int nr = r + dr[k], nc = c + dc[k];
        if (nr < 0 || nr > 2 || nc < 0 || nc > 2) continue;
        string t = s;
        swap(t[b], t[nr * 3 + nc]);
        children.push_back({t, mv[k]});
    }
    return children;
}

// TEST : is the candidate the goal?
bool test(const string &s) { return s == GOAL; }

int main() {
    string start = "813405276";
    cout << "Start board:\n";  showBoard(start);
    cout << "Goal board:\n";   showBoard(GOAL);

    queue<string> candidates;
    map<string, pair<string, char>> parent;   // child -> (parent, move)
    candidates.push(start);
    parent[start] = {"", '-'};
    long tested = 0;

    while (!candidates.empty()) {
        string cur = candidates.front();
        candidates.pop();
        tested++;
        if (test(cur)) {
            string path;
            for (string x = cur; parent[x].first != ""; x = parent[x].first)
                path += parent[x].second;
            reverse(path.begin(), path.end());
            cout << "\nGoal found!  Candidates tested : " << tested << "\n";
            cout << "Moves of blank (" << path.size() << ") : " << path << "\n";
            cout << "Final board:\n";  showBoard(cur);
            return 0;
        }
        for (auto &ch : generate(cur))
            if (!parent.count(ch.first)) {
                parent[ch.first] = {cur, ch.second};
                candidates.push(ch.first);
            }
    }
    cout << "No solution exists for this start board.\n";
    return 0;
}
