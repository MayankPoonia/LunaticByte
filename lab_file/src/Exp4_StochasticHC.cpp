// 3-SAT using Stochastic Hill Climbing
// F = (b v c') ^ (c v d') ^ (b') ^ (a' v e') ^ (c' v e) ^ (c' v d')
#include <iostream>
#include <vector>
#include <cmath>
#include <cstdlib>
#include <ctime>
using namespace std;

const int N = 5;
const char var[N] = {'a', 'b', 'c', 'd', 'e'};

int eval(const vector<int> &x) {          // clauses satisfied
    int a = x[0], b = x[1], c = x[2], d = x[3], e = x[4];
    return (b || !c) + (c || !d) + (!b) + (!a || !e) + (!c || e) + (!c || !d);
}

string str(const vector<int> &x) {
    string s;
    for (int v : x) s += char('0' + v);
    return s;
}

int main() {
    srand(312);                            // fixed seed -> repeatable run
    const double T = 0.8;                  // temperature constant
    vector<int> cur = {1, 1, 1, 1, 1};
    cout << "a b c d e = " << str(cur) << "   eval = " << eval(cur) << "\n\n";
    cout << "Iter  flip  neighbour  eval  P(move)  decision\n";

    for (int it = 1; it <= 100 && eval(cur) < 6; it++) {
        int i = rand() % N;                // pick a random neighbour
        vector<int> nxt = cur;
        nxt[i] = !nxt[i];
        int dE = eval(nxt) - eval(cur);
        double P = 1.0 / (1.0 + exp(-dE / T));   // sigmoid acceptance
        double r = (double)rand() / RAND_MAX;
        bool move = r < P;
        printf("%3d    %c     %s      %d    %.3f   %s\n", it, var[i],
               str(nxt).c_str(), eval(nxt), P, move ? "accept" : "reject");
        if (move) cur = nxt;
    }
    cout << "\nFinal : a b c d e = " << str(cur)
         << "   eval = " << eval(cur) << "\n";
    if (eval(cur) == 6) cout << "Formula satisfied.\n";
    else cout << "Not satisfied in 100 iterations.\n";
    return 0;
}
