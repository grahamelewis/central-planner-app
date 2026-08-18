% Synthetic corpus: a document class file.
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{synthclass}[2024/01/01 v1.0 Synthetic class]
\DeclareOption{twocolumn}{\OptionNotUsed}
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{article}}
\ProcessOptions\relax
\LoadClass[11pt]{article}
\RequirePackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\slshape\leftmark}
\fancyfoot[C]{\thepage}
\newcommand{\institution}[1]{\def\@institution{#1}}
\renewcommand{\maketitle}{%
  \begin{center}
    {\LARGE\bfseries \@title \par}
    \vskip 1em
    {\large \@author \par}
  \end{center}%
}
\endinput
