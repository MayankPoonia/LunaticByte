// 8-Puzzle using DFID (Depth First Iterative Deepening)
#include <iostream>
#include <vector>
#include <string>
using namespace std;

typedef vector<vector<int>> Board;
Board goal = {{1, 2, 3}, {8, 0, 4}, {7, 6, 5}};
long expanded = 0;
string moves;

void print(const Board &b) {
    for (auto &row : b) {
        for (int x : row) cout << (x ? char('0' + x) : '_') << " ";
        cout << "\n";
    }
}

void findBlank(const Board &b, int &r, int &c) {
    for (r = 0; r < 3; r++)
        for (c = 0; c < 3; c++)
            if (b[r][c] == 0) return;
}

// Depth limited DFS. 'last' stores the previous move so that
// the search never immediately undoes what it just did.
bool DLS(Board &b, int limit, char last) {
    if (b == goal) return true;
    if (limit == 0) return false;
    expanded++;
    int r, c;
    findBlank(b, r, c);
    const int dr[4] = {-1, 1, 0, 0}, dc[4] = {0, 0, -1, 1};
    const char name[4] = {'U', 'D', 'L', 'R'}, undo[4] = {'D', 'U', 'R', 'L'};
    for (int k = 0; k < 4; k++) {
        int nr = r + dr[k], nc = c + dc[k];
        if (nr < 0 || nr > 2 || nc < 0 || nc > 2 || last == undo[k]) continue;
        swap(b[r][c], b[nr][nc]);
        moves.push_back(name[k]);
        if (DLS(b, limit - 1, name[k])) return true;
        moves.pop_back();
        swap(b[r][c], b[nr][nc]);
    }
    return false;
}

int main() {
    Board start = {{8, 1, 3}, {4, 0, 5}, {2, 7, 6}};
    cout << "Initial State:\n";
    print(start);
    for (int depth = 0; depth <= 20; depth++) {
        Board b = start;
        long before = expanded;
        bool found = DLS(b, depth, '-');
        cout << "Depth limit " << depth << " -> nodes expanded: "
             << expanded - before << (found ? "  [GOAL]" : "") << "\n";
        if (found) {
            cout << "\nGoal reached at depth " << depth << "\n";
            cout << "Total nodes expanded : " << expanded << "\n";
            cout << "Blank moves          : " << moves << "\n";
            cout << "Final State:\n";
            print(b);
            return 0;
        }
    }
    cout << "Goal not found within depth 20\n";
    return 0;
}
