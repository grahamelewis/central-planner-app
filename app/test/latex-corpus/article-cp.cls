% article-cp.cls — synthetic document class wrapping article.
% Part of the Central Planner latex-corpus. All content is synthetic (A13).
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{article-cp}[2026/08/10 v0.3 Synthetic corpus class]

\DeclareOption{wide}{\PassOptionsToClass{a4paper}{article}}
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{article}}
\ProcessOptions\relax
\LoadClass[11pt]{article}

\RequirePackage{geometry}
\geometry{margin=2.6cm}

\makeatletter
\renewcommand{\@maketitle}{%
  \begin{center}%
    {\LARGE \@title \par}%
    \vskip 1em%
    {\large \@author \par}%
  \end{center}%
}
\newcommand{\cls@footer}{Synthetic corpus class}
\makeatother

\AtBeginDocument{\thispagestyle{plain}}
\AtEndDocument{\par\noindent\hfil\cls@footer\hfil}

\setlength{\parindent}{0pt}
\setlength{\parskip}{0.6em plus 0.2em}

\endinput
