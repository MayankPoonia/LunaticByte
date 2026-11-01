// AO* search on an AND-OR graph
// Every edge costs 1. h(n) = estimated cost to solve node n.
// A connector is a list of children: one child = OR branch,
// two or more children = AND arc (all must be solved).
#include <iostream>
#include <map>
#include <vector>
#include <climits>
using namespace std;

typedef vector<char> Connector;
map<char, vector<Connector>> G;      // graph
map<char, int> h;                    // heuristic / revised cost
map<char, bool> solved;
map<char, int> best;                 // index of chosen connector
int iter = 0;

int connectorCost(const Connector &c) {
    int cost = 0;
    for (char ch : c) cost += h[ch] + 1;          // edge weight = 1
    return cost;
}

string name(const Connector &c) {
    string s;
    for (size_t i = 0; i < c.size(); i++)
        s += (i ? " AND " : "") + string(1, c[i]);
    return s;
}

// Expands n along its current best partial solution, then revises h(n)
void AOStar(char n) {
    if (G[n].empty()) {               // terminal node
        solved[n] = true;
        return;
    }
    // revise cost of n using current estimates of children
    int minCost = INT_MAX;
    for (size_t i = 0; i < G[n].size(); i++) {
        int c = connectorCost(G[n][i]);
        if (c < minCost) { minCost = c; best[n] = i; }
    }
    cout << "Iter " << ++iter << ": expand " << n << "  h(" << n << ") "
         << h[n] << " -> " << minCost
         << "   best = [" << name(G[n][best[n]]) << "]\n";
    h[n] = minCost;

    // go down the marked connector until every child is solved
    Connector &bc = G[n][best[n]];
    for (char ch : bc)
        if (!solved[ch]) AOStar(ch);

    // children may have changed -> recompute and maybe switch connector
    int old = best[n], oldH = h[n];
    minCost = INT_MAX;
    for (size_t i = 0; i < G[n].size(); i++) {
        int c = connectorCost(G[n][i]);
        if (c < minCost) { minCost = c; best[n] = i; }
    }
    h[n] = minCost;
    if (best[n] != old) {             // a cheaper alternative appeared
        cout << "        revise " << n << ": switch to [" << name(G[n][best[n]])
             << "], h = " << h[n] << "\n";
        AOStar(n);
        return;
    }
    if (h[n] != oldH)
        cout << "        backtrack: h(" << n << ") updated "
             << oldH << " -> " << h[n] << "\n";
    bool all = true;
    for (char ch : bc) all = all && solved[ch];
    solved[n] = all;
}

void printSolution(char n, string indent) {
    cout << indent << n << " (h=" << h[n] << ")";
    if (G[n].empty()) { cout << "  solved\n"; return; }
    cout << "  -> [" << name(G[n][best[n]]) << "]\n";
    for (char ch : G[n][best[n]]) printSolution(ch, indent + "    ");
}

int main() {
    G['A'] = {{'B'}, {'C', 'D'}};
    G['B'] = {{'E', 'F'}, {'G'}};
    G['C'] = {{'H'}, {'I'}};
    G['D'] = {{'J', 'K'}};
    G['G'] = {{'L'}};
    G['H'] = {{'M', 'N'}};
    h = {{'A', 0}, {'B', 4}, {'C', 2}, {'D', 3}, {'E', 6}, {'F', 5}, {'G', 4},
         {'H', 1}, {'I', 7}, {'J', 1}, {'K', 0}, {'L', 9}, {'M', 2}, {'N', 1}};

    cout << "Running AO* from start node A\n\n";
    AOStar('A');
    cout << "\nMinimum cost of solving A = " << h['A'] << "\n";
    cout << "\nSolution graph:\n";
    printSolution('A', "  ");
    return 0;
}
